# Kanban Dev Environment on EC2

A remote development environment that runs [Kanban](https://www.npmjs.com/package/kanban) on an AWS EC2 instance and **automatically stops itself** when idle — so you pay only for the time you actually use it. Access is provided from anywhere via [Tailscale](https://tailscale.com/) VPN, with no public ports exposed.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Repository Structure](#repository-structure)
4. [Prerequisites](#prerequisites)
5. [Setup & Deployment](#setup--deployment)
6. [Accessing Kanban](#accessing-kanban)
7. [Starting a Stopped Instance](#starting-a-stopped-instance)
8. [Cost Optimization](#cost-optimization)
9. [Docker Configuration](#docker-configuration)
10. [Useful Commands](#useful-commands)

---

## Project Overview

This project uses the [AWS CDK](https://aws.amazon.com/cdk/) (TypeScript) to deploy:

- A **t3.medium** EC2 instance (2 vCPU, 4 GB RAM) running Ubuntu 24.04
- A **Kanban container** built and started automatically on first boot
- A **Tailscale container** that joins the instance to your private Tailscale network, providing secure remote access without opening any public ports
- A **CloudWatch alarm** that issues an EC2 `Stop` action when CPU utilization stays below 5% for 15 consecutive minutes — eliminating idle compute costs while keeping your EBS volume (and all work) intact

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AWS Account                                            │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  VPC (2 AZs)                                     │   │
│  │                                                  │   │
│  │  ┌────────────────────────────────────────────┐  │   │
│  │  │  EC2  t3.medium  Ubuntu 24.04  20 GB gp3   │  │   │
│  │  │                                            │  │   │
│  │  │  ┌──────────────┐  ┌──────────────────┐    │  │   │
│  │  │  │ kanban-dev   │  │   tailscale      │    │  │   │
│  │  │  │  container   │  │   container      │    │  │   │
│  │  │  │  :3484       │  │  (--net=host)    │    │  │   │
│  │  │  └──────────────┘  └──────────────────┘    │  │   │
│  │  └────────────────────────────────────────────┘  │   │
│  │                  │                               │   │
│  │        CloudWatch Alarm                          │   │
│  │     (CPU < 5% for 15 min → Stop)                 │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
          │  Tailscale VPN (encrypted, private)
          ▼
    Your laptop / browser
    http://<tailscale-ip>:3484
```

**Boot sequence (EC2 UserData):**

1. `apt-get` installs Docker Engine, the Compose plugin, `unzip`, and `awscli`
2. The `docker/` directory (Dockerfile + docker-compose.yml) is downloaded from S3 (uploaded automatically by CDK as an asset) and extracted to `/opt/kanban`
3. `docker compose build && docker compose up -d` builds and starts the Kanban container
4. A `tailscale/tailscale` container is started with `--net=host`, joining the instance to your Tailscale network under the hostname **dev-machine**

---

## Repository Structure

```
kanban-dev-env/
├── bin/
│   └── app.ts                 # CDK app entry point — instantiates Ec2SleeperStack
├── lib/
│   └── ec2-sleeper-stack.ts   # CDK stack (VPC, EC2, CloudWatch alarm)
├── docker/
│   ├── Dockerfile             # Node 22 image running kanban@latest on port 3484
│   └── docker-compose.yml     # Compose service; mounts /home/ubuntu into the container
├── cdk.json                   # CDK app config
├── package.json
└── tsconfig.json
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 22+** | Required to run the CDK CLI and compile TypeScript |
| **AWS CLI** | Configured with credentials for your target account (`aws configure`) |
| **AWS CDK CLI** | Included as a `devDependency`; use `npx cdk` or `npm install -g aws-cdk` |
| **AWS account bootstrapped** | One-time `npx cdk bootstrap` per account/region |
| **Tailscale account + auth key** | Create a reusable or ephemeral auth key at <https://login.tailscale.com/admin/settings/keys> |

---

## Setup & Deployment

### 1. Clone the repository

```bash
git clone <repo-url>
cd kanban-dev-env
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set your Tailscale auth key

The EC2 UserData starts a Tailscale container using `TS_AUTHKEY`. Before deploying, open `lib/ec2-sleeper-stack.ts` and replace the placeholder with your real auth key:

```typescript
// lib/ec2-sleeper-stack.ts  (~line 57)
'  -e TS_AUTHKEY=YOUR_TAILSCALE_AUTH_KEY \\',
//                ^^^^^^^^^^^^^^^^^^^^^^^^
//  Replace with your actual key, e.g. tskey-auth-xxxxxxxxxxxxx
```

> **Security tip:** Avoid committing real auth keys to source control. Consider loading the key from an environment variable or AWS Secrets Manager and interpolating it at synth time.

### 4. Bootstrap CDK (first time only)

```bash
npx cdk bootstrap
```

This creates the CDK toolkit stack in your AWS account/region (S3 bucket, ECR repo, IAM roles). Only needed once per account/region combination.

### 5. Deploy

```bash
npx cdk deploy
```

CDK will synthesize a CloudFormation template, upload the `docker/` directory as an S3 asset, and create the VPC, EC2 instance, and CloudWatch alarm. The first boot takes **3–5 minutes** while Docker builds the Kanban image.

---

## Accessing Kanban

No public security group rules are created for port 3484, so Kanban is reachable **only through Tailscale**.

### 1. Find the instance's Tailscale IP

1. Open the [Tailscale admin console → Machines](https://login.tailscale.com/admin/machines)
2. Look for the machine named **dev-machine**
3. Copy its Tailscale IP (e.g. `100.x.y.z`)

### 2. Open Kanban in your browser

```
http://100.x.y.z:3484
```

> The Tailscale container runs with `--net=host`, so port 3484 on the EC2 host is reachable from any device on your Tailscale network.

---

## Starting a Stopped Instance

The CloudWatch alarm automatically stops the instance after **15 minutes of CPU utilization below 5%** (3 consecutive 5-minute data points). Your EBS volume is preserved — no data is lost.

To restart the instance:

```bash
# Retrieve the instance ID from the AWS console, CDK outputs, or CloudFormation
aws ec2 start-instances --instance-ids i-0123456789abcdef0
```

Or start it directly from the [EC2 console](https://console.aws.amazon.com/ec2/). Allow 1–2 minutes for the OS to boot; both the Kanban and Tailscale containers restart automatically (`restart: always` / `--restart unless-stopped`).

### From a phone

The easiest way to start the instance from a mobile device is via the **AWS Console mobile app**:

1. Install the **AWS Console** app ([iOS](https://apps.apple.com/app/aws-console/id580990573) / [Android](https://play.google.com/store/apps/details?id=com.amazon.aws.console.mobile))
2. Sign in with your AWS account credentials (or an IAM user with `ec2:StartInstances` permission)
3. Tap **EC2** → **Instances**
4. Select your instance (look for `Ec2SleeperStack/DevMachine` in the name/tags)
5. Tap **Instance State** → **Start**

> If you do not want to install the app, open [console.aws.amazon.com/ec2](https://console.aws.amazon.com/ec2/) in your phone's browser — the responsive web console works fine for this single action.

---

## Cost Optimization

| Mechanism | Detail |
|---|---|
| **Auto-stop alarm** | CloudWatch stops the instance after 3 consecutive 5-minute periods below 5% CPU (~15 min idle). You pay for compute only while the instance is running. |
| **EBS persists on stop** | The 20 GB gp3 root volume is retained when stopped. You pay the gp3 storage rate (~$0.08/GB-month) continuously, but this is negligible compared to a running instance. |
| **Spot instances** | For non-critical workloads, switching to a Spot instance can cut compute cost by 60–90%. `ec2.Instance` does not natively support Spot; you would need a Launch Template with `InstanceMarketOptions` set to `spot`. |
| **Right-sizing** | `t3.medium` (2 vCPU, 4 GB) is a burstable type. If Kanban's workload is consistently lightweight, `t3.small` (2 vCPU, 2 GB) may be sufficient and costs roughly half as much. |

---

## Docker Configuration

### `docker/Dockerfile`

```dockerfile
FROM node:22-bookworm-slim

# Installs git, curl, openssh-client, sudo
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl openssh-client sudo ...

# Creates a non-root user 'max' (UID/GID 1000) with passwordless sudo
RUN groupadd --gid 1000 max && useradd --uid 1000 --gid 1000 \
    --create-home --shell /bin/bash max \
    && echo 'max ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER max
WORKDIR /home/max

# Launches kanban@latest on port 3484
CMD ["npx", "--yes", "kanban@latest", "--port", "3484"]
```

**Customization:**

- **Pin a Kanban version:** Replace `kanban@latest` with e.g. `kanban@1.2.3` in the `CMD`.
- **Change the port:** Update `3484` in the `CMD` above (the Compose file does not publish ports explicitly since it uses `network_mode: host`).
- **Add dev tools:** Insert `apt-get install` lines for any packages you need available inside the container.

### `docker/docker-compose.yml`

```yaml
services:
  kanban-dev:
    build:
      context: .
    container_name: kanban-dev
    network_mode: host          # Container shares the EC2 host network stack
    volumes:
      - /home/ubuntu:/home/max  # EC2 ubuntu home dir mounted as the container user's home
    restart: always             # Auto-restarts after EC2 stop/start cycles
    environment:
      - NODE_ENV=production
```

**Key points:**

- `network_mode: host` means port 3484 on the container is directly reachable on the EC2 host's network interfaces, including the Tailscale interface — no port-mapping needed.
- The volume `/home/ubuntu:/home/max` persists Kanban's boards, configuration, and any other data written to `~` across container and instance restarts.
- `restart: always` ensures Kanban comes back up automatically each time the EC2 instance starts.

---

## Useful Commands

| Command | Description |
|---|---|
| `npx cdk deploy` | Deploy or update the stack in your AWS account |
| `npx cdk diff` | Preview infrastructure changes before deploying |
| `npx cdk synth` | Synthesize and print the CloudFormation template |
| `npx cdk destroy` | Tear down all stack resources (⚠️ permanently deletes EC2, VPC, and EBS) |
| `npm run build` | Compile TypeScript via `tsc` (CDK uses `ts-node` automatically) |

> All `cdk` commands can also be run as `npm run cdk -- <subcommand>` using the `"cdk"` script defined in `package.json`.
