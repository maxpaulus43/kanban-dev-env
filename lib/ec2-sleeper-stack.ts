import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export class Ec2SleeperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'DevVpc', { maxAzs: 2 });

    // Bundle the docker/ directory as an S3 asset (Dockerfile + docker-compose.yml)
    const dockerAsset = new s3assets.Asset(this, 'DockerAsset', {
      path: path.join(__dirname, '..', 'docker'),
    });

    // Build userData script
    const userData = ec2.UserData.forLinux();

    // Install Docker Engine and Compose plugin
    userData.addCommands(
      'apt-get update',
      'apt-get install -y docker.io docker-compose-v2 unzip awscli',
      'systemctl enable --now docker',
    );

    // Download and extract the Docker asset from S3
    const assetPath = userData.addS3DownloadCommand({
      bucket: dockerAsset.bucket,
      bucketKey: dockerAsset.s3ObjectKey,
    });
    userData.addCommands(
      'mkdir -p /opt/kanban',
      `unzip -o ${assetPath} -d /opt/kanban`,
    );

    // Build and start the Kanban dev container
    // NOTE: The first build may take 15-20 minutes due to the dotfiles image
    // installing homebrew, neovim, fish, mise, and all CLI tools.
    userData.addCommands(
      'cd /opt/kanban',
      'docker compose build',
      'docker compose up -d',
    );

    // Run Tailscale in a separate container for VPN access
    userData.addCommands(
      'docker run -d \\',
      '  --name tailscale \\',
      '  --restart unless-stopped \\',
      '  --hostname dev-machine \\',
      '  --cap-add NET_ADMIN \\',
      '  --cap-add NET_RAW \\',
      '  -v /dev/net/tun:/dev/net/tun \\',
      '  -v tailscale-state:/var/lib/tailscale \\',
      '  -e TS_AUTHKEY=YOUR_TAILSCALE_AUTH_KEY \\',
      '  --net=host \\',
      '  tailscale/tailscale:latest',
    );

    // 1. Create the Instance
    const instance = new ec2.Instance(this, 'DevMachine', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: new ec2.InstanceType('t3.medium'), // 2 vCPU, 4 GB RAM
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
        { os: ec2.OperatingSystemType.LINUX },
      ),
      userData,
      blockDevices: [{
        deviceName: '/dev/sda1',
        volume: ec2.BlockDeviceVolume.ebs(50, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
        }),
      }],
    });

    // Grant the instance permission to read the Docker asset from S3
    dockerAsset.grantRead(instance.role);

    // Allow SSM Session Manager access for debugging
    instance.role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });

    // 2. The "Auto-Stop" Alarm
    const cpuMetric = new cloudwatch.Metric({
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensionsMap: { InstanceId: instance.instanceId },
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    });

    const idleAlarm = new cloudwatch.Alarm(this, 'IdleStopAlarm', {
      metric: cpuMetric,
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });

    // Add the STOP action to the alarm
    idleAlarm.addAlarmAction(
      new cw_actions.Ec2Action(cw_actions.Ec2InstanceAction.STOP),
    );
  }
}
