# Operations - the full-spectrum plan

One plugin for the person ("Operations": one switch, one interface), modular inside. It extends the
existing `aiops` pack (monitoring, alerts, incidents with evidence-cited root cause, runbooks, Kubernetes,
Grafana, traces, topology, anomalies, change intelligence), `devops` (IaC, CI, deploy) and `integrations`
(chat, paging, ticketing) into end-to-end operations: from management and inventory to monitoring,
security, logs, deployment and production management, across networks, devices, storage, hardware, software,
operating systems, switches, firewalls, routers, IoT devices and racks.

## Principles

1. **One plugin outside, connectors inside.** Each vendor or protocol is a connector: declared capabilities
   (discover, poll, receive, read config, change), credentials (Key Vault names), permission kinds (read
   vs change), its own tests against a simulator. A connector registers its tools only when configured, so
   the prompt stays lean. Third parties add vendors as connector plugins (`ops-connector-*`) without
   touching the core plugin.
2. **Model-free monitoring.** Polling, thresholds, correlation, deduplication, anomaly and forecast run
   without a model. Agents are called for investigation, root cause, change planning, reports - on demand.
3. **Read-only by default; changes are earned.** Every change is planned, dry-run with a diff, approved
   (by policy tier), applied, verified and reversible, and audited. Autonomy levels per operator policy:
   observe, suggest, act with approval, act within a maintenance window, act and report.
4. **Integrate, don't replace.** Existing monitoring and management tools are sources: their alerts,
   inventory and metrics flow in; their consoles are linked.
5. **Reuse the core.** `core.dashboards` for NOC and TV walls, reports and drill-down (DuckDB analytics and
   the CMDB queries); `core.diagrams` for network maps (L2/L3 from LLDP/CDP and routing), rack elevations,
   service and deployment maps; Prometheus or VictoriaMetrics for time series (never our own database).
6. **Agents drive every bit** through the same operations the interface uses (the platform rule).

## Architecture

- **Edge collector** (`ops-collector`): a small process deployed inside each site or segment (like the
  companion: outbound only, rotating token). It polls SNMP and Redfish, receives traps, syslog and flows,
  runs discovery, and forwards to the server. Without it, segmented on-prem networks cannot be watched.
- **CMDB / inventory**: assets (devices, interfaces, hosts, VMs, containers, services, racks, sites) and
  their relationships, with a source and a last-seen time per fact; NetBox as an optional source of truth.
- **Event pipeline**: traps, syslog, alerts from every source -> normalise -> deduplicate -> correlate by
  topology and time -> incidents (the existing grouping, extended with topology-aware suppression: a
  switch down explains its hosts' alerts).
- **Metrics**: collectors write to Prometheus (remote write) or VictoriaMetrics; the plugin queries them.

## Phases

**Phase 1 - see everything.**
Inventory and discovery (SNMP, LLDP/CDP, ARP, consented scans; cloud APIs; vSphere, Proxmox, Hyper-V;
Kubernetes; NetBox import). Network monitoring (SNMP v2c/v3 interfaces, errors, bandwidth, CPU, memory,
temperature; traps; syslog; NetFlow/sFlow/IPFIX top talkers; ping, latency, jitter; BGP/OSPF neighbour
state). Hardware via Redfish/IPMI (fans, power supplies, temperatures, disks, firmware). Windows hosts
(WinRM: services, event logs, performance counters, patches) next to Linux. Existing tools as sources
(Zabbix, Nagios/Icinga, LibreNMS, PRTG, CheckMk, Datadog, New Relic, Dynatrace, Splunk, Elastic). The edge
collector. Operations UI: Overview/NOC, Inventory, Network (map), Infrastructure (hardware), Hosts, Logs,
Incidents, Changes, built on core.dashboards and core.diagrams.

**Phase 2 - keep it right.**
Configuration backup, diff, drift and compliance for switches, routers and firewalls (SSH, NETCONF,
RESTCONF, vendor APIs: Cisco IOS/NX-OS, Juniper, Arista eAPI, Fortinet, Palo Alto, MikroTik); firewall
rule analysis; patch orchestration (Windows Update, apt/dnf) in maintenance windows; Ansible and
PowerShell DSC runs with approval; vulnerabilities matched to inventory (CVE feeds), certificates, CIS
benchmarks, Wazuh/SIEM integration; backup monitoring (Veeam, restic, Borg); change approval board.

**Phase 3 - the physical and the edge.**
Datacenter: sites, rooms, racks with elevations, power (PDU/UPS) and cooling, cable maps; storage arrays
(NetApp, Pure, Ceph, ZFS, Synology: capacity, latency, IOPS); IoT over MQTT (device health, firmware);
cloud cost (FinOps).

**Phase 4 - act on its own, within limits.**
Autonomy policies per change class, tiered auto-remediation with verification and rollback, predictive
maintenance (SMART trends, capacity), maintenance windows and on-call aware actions.

## Testing

Every connector is tested against a realistic simulator, not only mocks: snmpsim (SNMP agents and traps),
the DMTF Redfish mockup server, govmomi `vcsim` (vSphere), containerlab with FRR/VyOS (routing, LLDP,
BGP/OSPF), a syslog and NetFlow generator, mosquitto (MQTT), real Zabbix, LibreNMS, NetBox and Icinga
containers, LocalStack (AWS), a Windows host where available (else WinRM against a recorded fixture).
Evals with hidden checks per phase (e.g. "a link flaps on a core switch: the incident names the switch and
port, suppresses the hosts behind it, and the remediation is approved before it runs").
