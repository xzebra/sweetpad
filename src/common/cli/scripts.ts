import path from "node:path";
import { prepareDerivedDataPath } from "../../build/utils";
import type { DestinationPlatform } from "../../destination/constants";
import { cache } from "../cache";
import { ExtensionError } from "../errors";
import { exec } from "../exec";
import { uniqueFilter } from "../helpers";
import { commonLogger } from "../logger";
import { XcodeWorkspace } from "../xcode/workspace";

export type SimulatorOutput = {
  dataPath: string;
  dataPathSize: number;
  logPath: string;
  udid: string;
  isAvailable: boolean;
  deviceTypeIdentifier: string;
  state: string;
  name: string;
};

type SimulatorsOutput = {
  devices: { [key: string]: SimulatorOutput[] };
};

interface XcodebuildListProjectOutput {
  type: "project";
  project: {
    configurations: string[];
    name: string;
    schemes: string[];
    targets: string[];
  };
}

interface XcodebuildListWorkspaceOutput {
  type: "workspace";
  workspace: {
    name: string;
    schemes: string[];
  };
}

type XcodebuildListOutput = XcodebuildListProjectOutput | XcodebuildListWorkspaceOutput;

export type XcodeScheme = {
  name: string;
};

export type XcodeConfiguration = {
  name: string;
};

export async function getSimulators(): Promise<SimulatorsOutput> {
  const simulatorsRaw = await exec({
    command: "xcrun",
    args: ["simctl", "list", "--json", "devices"],
  });
  return JSON.parse(simulatorsRaw) as SimulatorsOutput;
}

export type BuildSettingsOutput = BuildSettingOutput[];

type BuildSettingOutput = {
  action: string;
  target: string;
  buildSettings: {
    [key: string]: string;
  };
};

export class XcodeBuildSettings {
  private settings: { [key: string]: string };

  constructor(output: BuildSettingsOutput) {
    if (output.length === 0) {
      // todo: improve logging
      throw new ExtensionError("Error fetching build settings");
    }
    this.settings = output[0]?.buildSettings;
  }

  get targetBuildDir() {
    // Example:
    // - /Users/hyzyla/Library/Developer/Xcode/DerivedData/ControlRoom-gdvrildvemgjaiameavxoegdskby/Build/Products/Debug
    return this.settings.TARGET_BUILD_DIR;
  }

  get executablePath() {
    // Example:
    // - {targetBuildDir}/Control Room.app/Contents/MacOS/Control Room
    return path.join(this.targetBuildDir, this.settings.EXECUTABLE_PATH);
  }

  get appPath() {
    // Example:
    // - {targetBuildDir}/Control Room.app
    return path.join(this.targetBuildDir, this.appName);
  }

  get appName() {
    // Example:
    // - "Control Room.app"
    if (this.settings.WRAPPER_NAME) {
      return this.settings.WRAPPER_NAME;
    }
    if (this.settings.FULL_PRODUCT_NAME) {
      return this.settings.FULL_PRODUCT_NAME;
    }
    if (this.settings.PRODUCT_NAME) {
      return `${this.settings.PRODUCT_NAME}.app`;
    }
    return `${this.targetName}.app`;
  }

  get targetName() {
    // Example:
    // - "ControlRoom"
    return this.settings.TARGET_NAME;
  }

  get bundleIdentifier() {
    // Example:
    // - "com.hackingwithswift.ControlRoom"
    return this.settings.PRODUCT_BUNDLE_IDENTIFIER;
  }

  get supportedPlatforms(): DestinationPlatform[] | undefined {
    // ex: ["iphonesimulator", "iphoneos"]
    const platformsRaw = this.settings.SUPPORTED_PLATFORMS; // ex: "iphonesimulator iphoneos"
    if (!platformsRaw) {
      return undefined;
    }
    return platformsRaw.split(" ").map((platform) => {
      return platform as DestinationPlatform;
    });
  }
}

/**
 * Extract build settings for the given scheme and configuration
 */
async function getBuildSettingsBase(options: {
  scheme: string;
  configuration: string;
  sdk: string | undefined;
  xcworkspace: string;
}): Promise<XcodeBuildSettings | null> {
  // Get project name from the path to use as default scheme
  const projectName = path.basename(options.xcworkspace.replace(/\.xcodeproj.*$/, ""));
  const effectiveScheme = options.scheme === "Model" ? projectName : options.scheme;
  
  const derivedDataPath = prepareDerivedDataPath();

  // Determine if we're dealing with a workspace or project
  const isWorkspace = options.xcworkspace.endsWith(".xcworkspace");
  const projectOrWorkspacePath = isWorkspace ? options.xcworkspace : options.xcworkspace.replace(/\/project\.xcworkspace$/, "");
  const buildFlag = isWorkspace ? "-workspace" : "-project";

  const args = [
    "-showBuildSettings",
    "-scheme",
    effectiveScheme,
    buildFlag,
    projectOrWorkspacePath,
    "-configuration",
    options.configuration,
    ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
    "-json",
  ];

  if (options.sdk !== undefined) {
    args.push("-sdk", options.sdk);
  }

  // Add debug destination for Swift Package builds
  args.push("-destination", "generic/platform=iOS");

  try {
    let output = await exec({
      command: "xcodebuild",
      args: args,
    });

    if (!output || output.trim() === "") {
      // If first attempt fails, try with -workspace instead of -project
      const workspaceArgs = [...args];
      workspaceArgs[3] = "-workspace"; // Replace -project with -workspace

      const workspaceOutput = await exec({
        command: "xcodebuild",
        args: workspaceArgs,
      });

      if (workspaceOutput && workspaceOutput.trim() !== "") {
        output = workspaceOutput;
      } else {
        return null;
      }
    }

    // First few lines can be invalid json, so we need to skip them, until we find "{" or "[" at the beginning of the line
    const lines = output.split("\n");
    let jsonStartLine = -1;
    let nonJsonLines: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      if (!line.startsWith("{") && !line.startsWith("[")) {
        nonJsonLines.push(line);
      }

      if (line.startsWith("{") || line.startsWith("[")) {
        jsonStartLine = i;
        break;
      }
    }

    if (jsonStartLine === -1) {
      return null;
    }

    try {
      const jsonData = lines.slice(jsonStartLine).join("\n");
      const output = JSON.parse(jsonData) as BuildSettingsOutput;
      
      if (!output || output.length === 0) {
        return null;
      }

      return new XcodeBuildSettings(output);
    } catch (e) {
      return null;
    }
  } catch (e) {
    return null;
  }
}

export async function getOptionalBuildSettings(options: {
  scheme: string;
  configuration: string;
  sdk: string | undefined;
  xcworkspace: string;
}): Promise<XcodeBuildSettings | null> {
  try {
    commonLogger.error("Getting build settings", {
      error: new Error("Build settings request"),
      options: options
    });

    const settings = await getBuildSettingsBase(options);
    
    if (!settings) {
      commonLogger.error("No settings returned", {
        error: new Error("Settings not found"),
        options: options
      });
    }
    
    return settings;
  } catch (e) {
    commonLogger.error("Build settings error", {
      error: e,
      options: options
    });
    return null;
  }
}

/**
 * Extract build settings for the given scheme and configuration
 */
export async function getBuildSettings(options: {
  scheme: string;
  configuration: string;
  sdk: string | undefined;
  xcworkspace: string;
}): Promise<XcodeBuildSettings> {
  const settings = await getOptionalBuildSettings(options);
  if (!settings) {
    commonLogger.error("Build settings failed", {
      error: new Error("No settings available"),
      options: options
    });
    throw new ExtensionError("Empty build settings");
  }
  return settings;
}

/**
 * Find if xcbeautify is installed
 */
export async function getIsXcbeautifyInstalled() {
  try {
    await exec({
      command: "which",
      args: ["xcbeautify"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Find if xcode-build-server is installed
 */
export async function getIsXcodeBuildServerInstalled() {
  try {
    await exec({
      command: "which",
      args: ["xcode-build-server"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

export const getBasicProjectInfo = cache(
  async (options: { xcworkspace: string | undefined }): Promise<XcodebuildListOutput> => {
    const stdout = await exec({
      command: "xcodebuild",
      args: ["-list", "-json", ...(options?.xcworkspace ? ["-workspace", options?.xcworkspace] : [])],
    });
    const parsed = JSON.parse(stdout);
    if (parsed.project) {
      return {
        type: "project",
        ...parsed,
      } as XcodebuildListProjectOutput;
    }
    return {
      type: "workspace",
      ...parsed,
    } as XcodebuildListWorkspaceOutput;
  },
);

export async function getSchemes(options: { xcworkspace: string | undefined }): Promise<XcodeScheme[]> {
  const output = await getBasicProjectInfo({
    xcworkspace: options?.xcworkspace,
  });
  if (output.type === "project") {
    return output.project.schemes.map((scheme) => {
      return {
        name: scheme,
      };
    });
  }
  return output.workspace.schemes.map((scheme) => {
    return {
      name: scheme,
    };
  });
}

export async function getTargets(options: { xcworkspace: string }): Promise<string[]> {
  const output = await getBasicProjectInfo({
    xcworkspace: options.xcworkspace,
  });
  if (output.type === "project") {
    return output.project.targets;
  }
  const xcworkspace = await XcodeWorkspace.parseWorkspace(options.xcworkspace);
  const projects = await xcworkspace.getProjects();
  return projects.flatMap((project) => project.getTargets());
}

export async function getBuildConfigurations(options: { xcworkspace: string }): Promise<XcodeConfiguration[]> {
  const output = await getBasicProjectInfo({
    xcworkspace: options.xcworkspace,
  });
  if (output.type === "project") {
    // todo: if workspace option is required, can this happen at all? 🤔
    return output.project.configurations.map((configuration) => {
      return {
        name: configuration,
      };
    });
  }
  if (output.type === "workspace") {
    const xcworkspace = await XcodeWorkspace.parseWorkspace(options.xcworkspace);
    const projects = await xcworkspace.getProjects();

    commonLogger.debug("Projects", {
      paths: projects.map((project) => project.projectPath),
    });

    return projects
      .flatMap((project) => {
        commonLogger.debug("Project configurations", {
          configurations: project.getConfigurations(),
        });
        return project.getConfigurations();
      })
      .filter(uniqueFilter)
      .map((configuration) => {
        return {
          name: configuration,
        };
      });
  }
  return [];
}

/**
 * Generate xcode-build-server config
 */
export async function generateBuildServerConfig(options: { xcworkspace: string; scheme: string }) {
  await exec({
    command: "xcode-build-server",
    args: ["config", "-workspace", options.xcworkspace, "-scheme", options.scheme],
  });
}

/**
 * Is XcodeGen installed?s
 */
export async function getIsXcodeGenInstalled() {
  try {
    await exec({
      command: "which",
      args: ["xcodegen"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function generateXcodeGen() {
  await exec({
    command: "xcodegen",
    args: ["generate"],
  });
}

export async function getIsTuistInstalled() {
  try {
    await exec({
      command: "which",
      args: ["tuist"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

export async function tuistGenerate() {
  return await exec({
    command: "tuist",
    args: ["generate", "--no-open"],
  });
}

export async function tuistClean() {
  await exec({
    command: "tuist",
    args: ["clean"],
  });
}

export async function tuistInstall() {
  await exec({
    command: "tuist",
    args: ["install"],
  });
}

export async function tuistEdit() {
  await exec({
    command: "tuist",
    args: ["edit"],
  });
}

/**
 * Get the Xcode version installed on the system using xcodebuild
 *
 * This version works properly with Xcodes.app, so it's the recommended one
 */
export async function getXcodeVersionInstalled(): Promise<{
  major: number;
}> {
  //~ xcodebuild -version
  // Xcode 16.0
  // Build version 16A242d
  const stdout = await exec({
    command: "xcodebuild",
    args: ["-version"],
  });

  const versionMatch = stdout.match(/Xcode (\d+)\./);
  if (!versionMatch) {
    throw new ExtensionError("Error parsing xcode version", {
      context: {
        stdout: stdout,
      },
    });
  }
  const major = Number.parseInt(versionMatch[1]);
  return {
    major,
  };
}

/**
 * Get the Xcode version installed on the system using pgkutils
 *
 * This version doesn't work properly with Xcodes.app, leave it for reference
 */
export async function getXcodeVersionInstalled_pkgutils(): Promise<{
  major: number;
}> {
  const stdout = await exec({
    command: "pkgutil",
    args: ["--pkg-info=com.apple.pkg.CLTools_Executables"],
  });

  /*
  package-id: com.apple.pkg.CLTools_Executables
  version: 15.3.0.0.1.1708646388
  volume: /
  location: /
  install-time: 1718529452
  */
  const versionMatch = stdout.match(/version:\s*(\d+)\./);
  if (!versionMatch) {
    throw new ExtensionError("Error parsing xcode version", {
      context: {
        stdout: stdout,
      },
    });
  }

  const major = Number.parseInt(versionMatch[1]);
  return {
    major,
  };
}
