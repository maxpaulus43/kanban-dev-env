import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import { Construct } from "constructs";

export class Ec2SleeperStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vpc = new ec2.Vpc(this, "DevVpc", { maxAzs: 2 });

        // Build userData script
        const userData = ec2.UserData.forLinux();

        // Step 1: Install prerequisites
        userData.addCommands(
            "apt-get update",
            "apt-get install -y ca-certificates curl gnupg",
        );

        // Step 2: Install Docker via official Docker apt repository
        userData.addCommands(
            "install -m 0755 -d /etc/apt/keyrings",
            "curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc",
            "chmod a+r /etc/apt/keyrings/docker.asc",
            'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list',
            "apt-get update",
            "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
            "systemctl enable --now docker",
        );

        // Step 3: Pull pre-built image and run Kanban dev container
        userData.addCommands(
            "mkdir -p /home/ubuntu/workspace",
            "mkdir -p /home/ubuntu/.cline",
            "chown 1000:1000 /home/ubuntu/workspace",
            "chown 1000:1000 /home/ubuntu/.cline",
            // Pull pre-built image from GHCR (public, no auth needed)
            "docker pull ghcr.io/maxpaulus43/dotfiles:latest",
            // Run Kanban dev container
            "docker run -d \\",
            "  --name kanban-dev \\",
            "  --net=host \\",
            "  --user max \\",
            "  -v /home/ubuntu/workspace:/home/max/workspace \\",
            "  -v /home/ubuntu/.cline:/home/max/.cline \\",
            "  --restart always \\",
            "  -e NODE_ENV=production \\",
            "  ghcr.io/maxpaulus43/dotfiles:latest \\",
            '  /bin/bash -lc "npx --yes kanban@latest --port 3484"',
        );

        const TS_AUTHKEY = process.env.TS_AUTHKEY;

        if (!TS_AUTHKEY) {
            throw new Error(
                "TAILSCALE_AUTH_KEY environment variable is required",
            );
        }

        // Run Tailscale in a separate container for VPN access
        // TS_STATE_DIR persists Tailscale identity across container restarts
        // TS_AUTH_ONCE=true prevents re-authentication when state already exists,
        //   so the same device is reused on EC2 stop/start cycles instead of
        //   creating a new device on the tailnet each time
        userData.addCommands(
            "mkdir -p /opt/tailscale-state",
            "docker run -d \\",
            "  --name tailscale \\",
            "  --restart unless-stopped \\",
            "  --hostname dev-machine \\",
            "  --cap-add NET_ADMIN \\",
            "  --cap-add NET_RAW \\",
            "  -v /dev/net/tun:/dev/net/tun \\",
            "  -v /opt/tailscale-state:/var/lib/tailscale \\",
            `  -e TS_AUTHKEY=${TS_AUTHKEY} \\`,
            "  -e TS_STATE_DIR=/var/lib/tailscale \\",
            "  -e TS_AUTH_ONCE=true \\",
            "  -e TS_HOSTNAME=dev-machine \\",
            "  --net=host \\",
            "  tailscale/tailscale:latest",
        );

        // 1. Create the Instance
        const instance = new ec2.Instance(this, "DevMachine", {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            associatePublicIpAddress: true,
            instanceType: new ec2.InstanceType("t3.medium"), // 2 vCPU, 4 GB RAM
            machineImage: ec2.MachineImage.fromSsmParameter(
                "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
                { os: ec2.OperatingSystemType.LINUX },
            ),
            userData,
            blockDevices: [
                {
                    deviceName: "/dev/sda1",
                    volume: ec2.BlockDeviceVolume.ebs(50, {
                        volumeType: ec2.EbsDeviceVolumeType.GP3,
                    }),
                },
            ],
        });

        // Allow SSM Session Manager access for debugging
        instance.role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                "AmazonSSMManagedInstanceCore",
            ),
        );

        new cdk.CfnOutput(this, "InstanceId", {
            value: instance.instanceId,
        });

        // 2. The "Auto-Stop" Alarm
        const cpuMetric = new cloudwatch.Metric({
            namespace: "AWS/EC2",
            metricName: "CPUUtilization",
            dimensionsMap: { InstanceId: instance.instanceId },
            period: cdk.Duration.minutes(5),
            statistic: "Average",
        });

        const idleAlarm = new cloudwatch.Alarm(this, "IdleStopAlarm", {
            metric: cpuMetric,
            threshold: 5,
            evaluationPeriods: 3,
            datapointsToAlarm: 3,
            comparisonOperator:
                cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        });

        // Add the STOP action to the alarm
        idleAlarm.addAlarmAction(
            new cw_actions.Ec2Action(cw_actions.Ec2InstanceAction.STOP),
        );
    }
}
