import { ServerStatus } from "../models/types.js";
import { Logger } from "./logger.js";

type StatusCommandRunner = (
  command: string,
  connectionName: string,
) => Promise<string>;

/**
 * Collect system status information from remote server
 */
export async function collectSystemStatus(
  runCommand: StatusCommandRunner,
  connectionName: string
): Promise<ServerStatus> {
  const status: ServerStatus = {
    reachable: true,
    lastUpdated: new Date().toISOString(),
  };

  try {
    const runCommandsWithConcurrencyLimit = async (
      commands: string[],
      limit: number,
    ): Promise<string[]> => {
      const results = new Array<string>(commands.length).fill("");
      let nextIndex = 0;

      const worker = async (): Promise<void> => {
        while (nextIndex < commands.length) {
          const currentIndex = nextIndex++;
          try {
            results[currentIndex] = await runCommand(
              commands[currentIndex],
              connectionName,
            );
          } catch {
            results[currentIndex] = "";
          }
        }
      };

      const workerCount = Math.min(limit, commands.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => worker()),
      );

      return results;
    };
    // Collect all status information in parallel where possible
    const commands = {
      hostname: "hostname",
      ipAddresses: "ip -o addr show | awk '{print $4}' | grep -v '^127\\.' | cut -d'/' -f1",
      osName: "uname -s",
      osVersion: "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d'=' -f2 | tr -d '\"' || uname -o",
      kernelVersion: "uname -r",
      uptime: "uptime -p 2>/dev/null || uptime | awk -F'up ' '{print $2}' | awk -F',' '{print $1}'",
      diskSpace: "df -h / | tail -1 | awk '{print \"free:\" $4 \" total:\" $2}'",
      memory: "free -h | grep '^Mem:' | awk '{print \"free:\" $7 \" total:\" $2}'",
      cpuName: "sh -c '(lscpu 2>/dev/null | grep \"^Model name:\" | cut -d\":\" -f2 | xargs || cat /proc/cpuinfo 2>/dev/null | grep \"model name\" | head -1 | cut -d\":\" -f2 | xargs || echo \"$(nproc 2>/dev/null || echo '\''?'\'')-core $(uname -m 2>/dev/null || echo '\''unknown'\'') processor\") || true'",
      cpuUsage: "top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'",
      gpus: "sh -c '(nvidia-smi --query-gpu=name,utilization.gpu --format=csv,noheader,nounits 2>/dev/null | while IFS=\",\" read -r name usage; do echo \"NVIDIA|${name}|${usage}\"; done || lspci | grep -iE \"vga|3d|display\" | while read -r line; do gpu_name=$(echo \"$line\" | cut -d\":\" -f3 | xargs); echo \"OTHER|${gpu_name}|\"; done) || true'",
      gpuPaths: "ls -1 /dev/dri/card* 2>/dev/null | sort -V || echo ''",
      drives: "df -h | awk 'NR>1 && $1 !~ /^(tmpfs|devtmpfs|overlay|shfs|rootfs)$/ && $6 !~ /^(\\/dev|\\/run|\\/sys|\\/proc|\\/boot|\\/usr|\\/lib)$/ && $6 != \"\" {print $1\"|\"$2\"|\"$3\"|\"$4\"|\"$5\"|\"$6}'",
      // Old gpuPaths: "sh -c '(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -1 || rocm-smi --showuse 2>/dev/null | grep -i \"GPU use\" | head -1 | awk \"{print \\$NF}\" | tr -d \"%\" || radeontop -l 1 -d - 2>/dev/null | tail -1 | sed -n \"s/.*gpu \\([0-9.]*\\)%.*/\\1/p\" || intel_gpu_top -l 1 -o - 2>/dev/null | tail -1 | awk \"{print \\$NF}\" | tr -d \"%\" || echo \"N/A\") || echo \"N/A\"'",
      processes: "ps aux | wc -l",
      threads: "ps -eLf | wc -l",
      servicesRunning: "systemctl list-units --type=service --state=running 2>/dev/null | wc -l || service --status-all 2>/dev/null | grep running | wc -l || echo '0'",
      servicesInstalled: "systemctl list-unit-files --type=service 2>/dev/null | wc -l || ls /etc/init.d/ 2>/dev/null | wc -l || echo '0'",
    };

    // Execute commands and collect results
    const resultValues = await runCommandsWithConcurrencyLimit(
      [
        commands.hostname,
        commands.ipAddresses,
        commands.osName,
        commands.osVersion,
        commands.kernelVersion,
        commands.uptime,
        commands.diskSpace,
        commands.memory,
        commands.cpuName,
        commands.cpuUsage,
        commands.gpus,
        commands.gpuPaths,
        commands.drives,
        commands.processes,
        commands.threads,
        commands.servicesRunning,
        commands.servicesInstalled,
      ],
      3,
    );

    // Parse results
    const [
      hostnameValue,
      ipAddressesValue,
      osNameValue,
      osVersionValue,
      kernelVersionValue,
      uptimeValue,
      diskSpaceValue,
      memoryValue,
      cpuNameValue,
      cpuUsageValue,
      gpusValue,
      gpuPathsValue,
      drivesValue,
      processesValue,
      threadsValue,
      servicesRunningValue,
      servicesInstalledValue,
    ] = resultValues;

    if (hostnameValue) {
      status.hostname = hostnameValue;
    }

    if (ipAddressesValue) {
      status.ipAddresses = ipAddressesValue
        .split("\n")
        .filter((ip) => ip.trim() && !ip.includes("127.0.0.1"));
    }

    if (osNameValue) {
      status.osName = osNameValue;
    }

    if (osVersionValue) {
      status.osVersion = osVersionValue;
    }

    if (kernelVersionValue) {
      status.kernelVersion = kernelVersionValue;
    }

    if (uptimeValue) {
      status.uptime = uptimeValue;
    }

    if (diskSpaceValue) {
      const diskMatch = diskSpaceValue.match(/free:(\S+)\s+total:(\S+)/);
      if (diskMatch) {
        status.diskSpace = {
          free: diskMatch[1],
          total: diskMatch[2],
        };
      }
    }

    if (memoryValue) {
      const memMatch = memoryValue.match(/free:(\S+)\s+total:(\S+)/);
      if (memMatch) {
        status.memory = {
          free: memMatch[1],
          total: memMatch[2],
        };
      }
    }

    // Handle CPU name
    if (cpuNameValue && cpuNameValue.trim()) {
      status.cpu = {
        name: cpuNameValue.trim(),
      };
    }
    
    if (status.cpu && cpuUsageValue && cpuUsageValue !== "N/A") {
      status.cpu.usage = `${parseFloat(cpuUsageValue).toFixed(1)}%`;
    }

    // Handle GPUs
    if (gpusValue && gpusValue.trim()) {
      const gpuPaths: string[] = [];
      if (gpuPathsValue) {
        gpuPaths.push(...gpuPathsValue.split("\n").filter((p) => p.trim()));
      }
      
      const gpuLines = gpusValue.split("\n").filter((line) => line.trim());
      const gpus: Array<{ name: string; usage?: string; path?: string }> = [];
      
      gpuLines.forEach((line, index) => {
        const parts = line.split("|");
        if (parts.length >= 2) {
          const name = parts[1].trim();
          const usage = parts[2]?.trim();
          
          if (name && name !== "N/A") {
            const gpu: { name: string; usage?: string; path?: string } = {
              name: name,
            };
            
            if (usage && usage.trim() !== "" && usage.trim() !== "N/A" && !isNaN(parseFloat(usage.trim()))) {
              gpu.usage = `${parseFloat(usage.trim()).toFixed(1)}%`;
            }
            
            // Assign path if available
            if (gpuPaths[index]) {
              gpu.path = gpuPaths[index];
            }
            
            gpus.push(gpu);
          }
        }
      });
      
      if (gpus.length > 0) {
        status.gpus = gpus;
      }
    }
    
    // Handle drives
    if (drivesValue && drivesValue.trim()) {
      const driveLines = drivesValue.split("\n").filter((line) => line.trim());
      const drives: Array<{
        device: string;
        mountPoint: string;
        total: string;
        used: string;
        free: string;
        usagePercent: string;
        filesystem?: string;
      }> = [];
      
      driveLines.forEach((line) => {
        const parts = line.split("|");
        if (parts.length >= 6) {
          const device = parts[0].trim();
          const total = parts[1].trim();
          const used = parts[2].trim();
          const free = parts[3].trim();
          const usagePercent = parts[4].trim();
          const mountPoint = parts[5].trim();
          
          if (device && mountPoint) {
            drives.push({
              device,
              mountPoint,
              total,
              used,
              free,
              usagePercent,
            });
          }
        }
      });
      
      if (drives.length > 0) {
        status.drives = drives;
      }
    }

    if (processesValue || threadsValue) {
      const processCount = parseInt(processesValue || "0", 10) - 1; // Subtract header line
      const threadCount = parseInt(threadsValue || "0", 10) - 1; // Subtract header line
      status.processes = {
        running: Math.max(0, processCount),
        threads: Math.max(0, threadCount),
      };
    }

    if (servicesRunningValue || servicesInstalledValue) {
      const runningCount = parseInt(servicesRunningValue || "0", 10) - 1; // Subtract header line
      const installedCount = parseInt(servicesInstalledValue || "0", 10) - 1; // Subtract header line
      status.services = {
        running: Math.max(0, runningCount),
        installed: Math.max(0, installedCount),
      };
    }
  } catch (error) {
    Logger.log(
      `Failed to collect system status for [${connectionName}]: ${(error as Error).message}`,
      "error"
    );
    status.reachable = false;
  }

  return status;
}
