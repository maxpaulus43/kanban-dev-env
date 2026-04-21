import * as cdk from 'aws-cdk-lib';
import { Ec2SleeperStack } from '../lib/ec2-sleeper-stack';

const app = new cdk.App();
new Ec2SleeperStack(app, 'Ec2SleeperStack');
