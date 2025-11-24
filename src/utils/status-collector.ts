import { Client } from "ssh2";
import { ServerStatus } from "../models/types.js";
import { Logger } from "./logger.js";

/**
 * Collect system status information from remote server
 */
export async function collectSystemStatus(
  client: Client,
  connectionName: string
): Promise<ServerStatus> {
  const status: ServerStatus = {
    reachable: true,
    lastUpdated: new Date().toISOString(),
  };

  try {
    // Helper function to execute command and parse output
    const execCommand = (command: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          let data = "";
          stream.on("data", (chunk: Buffer) => {
            data += chunk.toString();
          });
          stream.on("close", (code: number) => {
            if (code === 0) {
              resolve(data.trim());
            } else {
              reject(new Error(`Command exited with code ${code}`));
            }
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            // Collect stderr but don't fail on it
            data += chunk.toString();
          });
        });
      });
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
    const results = await Promise.allSettled([
      execCommand(commands.hostname).catch(() => ""),
      execCommand(commands.ipAddresses).catch(() => ""),
      execCommand(commands.osName).catch(() => ""),
      execCommand(commands.osVersion).catch(() => ""),
      execCommand(commands.kernelVersion).catch(() => ""),
      execCommand(commands.uptime).catch(() => ""),
      execCommand(commands.diskSpace).catch(() => ""),
      execCommand(commands.memory).catch(() => ""),
      execCommand(commands.cpuName).catch(() => ""),
      execCommand(commands.cpuUsage).catch(() => ""),
      execCommand(commands.gpus).catch(() => ""),
      execCommand(commands.gpuPaths).catch(() => ""),
      execCommand(commands.drives).catch(() => ""),
      execCommand(commands.processes).catch(() => "0"),
      execCommand(commands.threads).catch(() => "0"),
      execCommand(commands.servicesRunning).catch(() => "0"),
      execCommand(commands.servicesInstalled).catch(() => "0"),
    ]);

    // Parse results
    const [
      hostnameResult,
      ipAddressesResult,
      osNameResult,
      osVersionResult,
      kernelVersionResult,
      uptimeResult,
      diskSpaceResult,
      memoryResult,
      cpuNameResult,
      cpuUsageResult,
      gpusResult,
      gpuPathsResult,
      drivesResult,
      processesResult,
      threadsResult,
      servicesRunningResult,
      servicesInstalledResult,
    ] = results;

    if (hostnameResult.status === "fulfilled" && hostnameResult.value) {
      status.hostname = hostnameResult.value;
    }

    if (ipAddressesResult.status === "fulfilled" && ipAddressesResult.value) {
      status.ipAddresses = ipAddressesResult.value
        .split("\n")
        .filter((ip) => ip.trim() && !ip.includes("127.0.0.1"));
    }

    if (osNameResult.status === "fulfilled" && osNameResult.value) {
      status.osName = osNameResult.value;
    }

    if (osVersionResult.status === "fulfilled" && osVersionResult.value) {
      status.osVersion = osVersionResult.value;
    }

    if (kernelVersionResult.status === "fulfilled" && kernelVersionResult.value) {
      status.kernelVersion = kernelVersionResult.value;
    }

    if (uptimeResult.status === "fulfilled" && uptimeResult.value) {
      status.uptime = uptimeResult.value;
    }

    if (diskSpaceResult.status === "fulfilled" && diskSpaceResult.value) {
      const diskMatch = diskSpaceResult.value.match(/free:(\S+)\s+total:(\S+)/);
      if (diskMatch) {
        status.diskSpace = {
          free: diskMatch[1],
          total: diskMatch[2],
        };
      }
    }

    if (memoryResult.status === "fulfilled" && memoryResult.value) {
      const memMatch = memoryResult.value.match(/free:(\S+)\s+total:(\S+)/);
      if (memMatch) {
        status.memory = {
          free: memMatch[1],
          total: memMatch[2],
        };
      }
    }

    // Handle CPU name
    if (cpuNameResult.status === "fulfilled" && cpuNameResult.value && cpuNameResult.value.trim()) {
      status.cpu = {
        name: cpuNameResult.value.trim(),
      };
    }
    
    if (status.cpu && cpuUsageResult.status === "fulfilled" && cpuUsageResult.value && cpuUsageResult.value !== "N/A") {
      status.cpu.usage = `${parseFloat(cpuUsageResult.value).toFixed(1)}%`;
    }

    // Handle GPUs
    if (gpusResult.status === "fulfilled" && gpusResult.value && gpusResult.value.trim()) {
      const gpuPaths: string[] = [];
      if (gpuPathsResult.status === "fulfilled" && gpuPathsResult.value) {
        gpuPaths.push(...gpuPathsResult.value.split("\n").filter((p) => p.trim()));
      }
      
      const gpuLines = gpusResult.value.split("\n").filter((line) => line.trim());
      const gpus: Array<{ name: string; usage?: string; path?: string }> = [];
      
      gpuLines.forEach((line, index) => {
        const parts = line.split("|");
        if (parts.length >= 2) {
          const vendor = parts[0].trim();
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
    if (drivesResult.status === "fulfilled" && drivesResult.value && drivesResult.value.trim()) {
      const driveLines = drivesResult.value.split("\n").filter((line) => line.trim());
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

    if (processesResult.status === "fulfilled" && threadsResult.status === "fulfilled") {
      const processCount = parseInt(processesResult.value, 10) - 1; // Subtract header line
      const threadCount = parseInt(threadsResult.value, 10) - 1; // Subtract header line
      status.processes = {
        running: Math.max(0, processCount),
        threads: Math.max(0, threadCount),
      };
    }

    if (servicesRunningResult.status === "fulfilled" && servicesInstalledResult.status === "fulfilled") {
      const runningCount = parseInt(servicesRunningResult.value, 10) - 1; // Subtract header line
      const installedCount = parseInt(servicesInstalledResult.value, 10) - 1; // Subtract header line
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
