import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { commonLogger } from "./logger";

const execPromise = promisify(execCallback);

export async function exec(options: {
  command: string;
  args: string[];
}): Promise<string> {
  const command = `${options.command} ${options.args.join(" ")}`;
  
  try {
    commonLogger.error("Executing command", {
      error: new Error("Command execution"),
      command: command
    });

    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) {
      commonLogger.error("Command stderr", {
        error: new Error("Command error output"),
        stderr: stderr,
        command: command
      });
    }

    commonLogger.error("Command stdout", {
      error: new Error("Command output"),
      stdout: stdout,
      command: command
    });

    return stdout;
  } catch (error: any) {
    commonLogger.error("Command execution failed", {
      error: error,
      stderr: error.stderr,
      stdout: error.stdout,
      command: command
    });
    throw error;
  }
}
