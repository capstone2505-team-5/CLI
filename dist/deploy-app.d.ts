#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
interface DeploymentConfig {
    appName: string;
    environment: string;
    vpcId: string;
    vpnCidrBlocks: string[];
    openApiKey: string;
    phoenixApiKey: string;
    phoenixApiUrl: string;
    awsProfile: string;
}
export declare class AppDeploymentStack extends cdk.Stack {
    constructor(scope: Construct, id: string, config: DeploymentConfig, props?: cdk.StackProps);
    private createSecurityGroups;
    private createDatabase;
    private createAppInstance;
    private createUserDataScript;
    private createDockerCompose;
    private createEnvSetupScript;
    private createOutputs;
}
export {};
