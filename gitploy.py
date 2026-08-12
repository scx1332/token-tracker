import os
import subprocess
import time
import threading
from os import environ

# Path to the script you want to call after a successful pull
if os.name == 'nt':
    SCRIPT_TO_RUN = environ.get("GITPLOY_SCRIPT_TO_RUN", "deploy.bat")
else:
    SCRIPT_TO_RUN = environ.get("GITPLOY_SCRIPT_TO_RUN", "./deploy.sh")

UPDATE_EVERY_SECS = int(environ.get("GITPLOY_UPDATE_EVERY_SECS", "60"))


def run_command(command):
    """Run a shell command and return its output, error, and exit code."""
    result = subprocess.run(command, shell=True, capture_output=True, text=True)
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def stream_process(command):
    """Run a command and stream its stdout and stderr in real time."""
    process = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )

    def stream_output(stream, prefix):
        for line in iter(stream.readline, ''):
            print(f"{prefix}{line}", end="")
        stream.close()

    # Start threads for stdout and stderr
    threading.Thread(target=stream_output, args=(process.stdout, "[OUT] ")).start()
    threading.Thread(target=stream_output, args=(process.stderr, "[ERR] ")).start()

    process.wait()
    return process.returncode


def main():
    last_output = None
    while True:
        print("Running git pull...")
        output, error, code = run_command("git pull")

        if code != 0:
            print(f"[ERROR] git pull failed:\n{error}")
        else:
            print(output)
            # Only run the script if there were new changes
            if output != last_output and "Already up to date" not in output:
                print("Changes detected! Running script...")
                stream_process(SCRIPT_TO_RUN)

            last_output = output

        time.sleep(UPDATE_EVERY_SECS)


if __name__ == "__main__":
    main()
