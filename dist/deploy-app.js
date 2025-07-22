#!/usr/bin/env node
"use strict";
// deploy-app.ts
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppDeploymentStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const rds = __importStar(require("aws-cdk-lib/aws-rds"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const inquirer_1 = __importDefault(require("inquirer"));
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const child_process_2 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_2.exec);
// Main deployment stack
class AppDeploymentStack extends cdk.Stack {
    constructor(scope, id, config, props) {
        super(scope, id, props);
        // Import existing VPC
        const vpc = ec2.Vpc.fromLookup(this, "ExistingVpc", {
            vpcId: config.vpcId,
        });
        // Automatically detect private subnets in the VPC
        const privateSubnetSelection = {
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        };
        // Create security groups
        const { appSecurityGroup, dbSecurityGroup } = this.createSecurityGroups(vpc, config);
        // Create RDS database
        const database = this.createDatabase(vpc, privateSubnetSelection, dbSecurityGroup, config);
        // Create EC2 instance with Docker
        const appInstance = this.createAppInstance(vpc, privateSubnetSelection, appSecurityGroup, database, config);
        // Create outputs
        this.createOutputs(config, appInstance, database);
    }
    createSecurityGroups(vpc, config) {
        // Application security group
        const appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
            vpc,
            description: `Security group for ${config.appName}`,
            allowAllOutbound: true,
        });
        // Allow access from VPN networks
        config.vpnCidrBlocks.forEach((cidr, index) => {
            appSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `HTTP from VPN network ${index + 1}: ${cidr}`);
            appSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(22), `SSH from VPN network ${index + 1}: ${cidr}`);
        });
        // Database security group
        const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
            vpc,
            description: "Security group for database",
            allowAllOutbound: false,
        });
        dbSecurityGroup.addIngressRule(appSecurityGroup, ec2.Port.tcp(5432), "PostgreSQL from app instances");
        return { appSecurityGroup, dbSecurityGroup };
    }
    createDatabase(vpc, subnetSelection, securityGroup, config) {
        const dbSubnetGroup = new rds.SubnetGroup(this, "DatabaseSubnetGroup", {
            vpc,
            description: "Subnet group for RDS database",
            vpcSubnets: subnetSelection,
        });
        return new rds.DatabaseInstance(this, "Database", {
            engine: rds.DatabaseInstanceEngine.postgres({
                version: rds.PostgresEngineVersion.VER_15_4,
            }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // Free tier
            credentials: rds.Credentials.fromGeneratedSecret("appuser", {
                secretName: `${config.appName}-db-credentials`,
            }),
            vpc,
            subnetGroup: dbSubnetGroup,
            securityGroups: [securityGroup],
            databaseName: "error_analysis",
            allocatedStorage: 20, // Free tier
            maxAllocatedStorage: 100,
            storageEncrypted: true,
            multiAz: false, // Single AZ for free tier
            backupRetention: cdk.Duration.days(7),
            deletionProtection: false,
            deleteAutomatedBackups: false,
        });
    }
    createAppInstance(vpc, subnetSelection, securityGroup, database, config) {
        // Create IAM role for EC2
        const instanceRole = new iam.Role(this, "InstanceRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
            ],
        });
        // Grant access to database secret
        database.secret?.grantRead(instanceRole);
        // Create user data script
        const userData = this.createUserDataScript(database, config);
        return new ec2.Instance(this, "AppInstance", {
            vpc,
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // Free tier
            machineImage: ec2.MachineImage.latestAmazonLinux2(),
            securityGroup,
            vpcSubnets: subnetSelection,
            role: instanceRole,
            userData,
            blockDevices: [
                {
                    deviceName: "/dev/xvda",
                    volume: ec2.BlockDeviceVolume.ebs(8, {
                        // Free tier
                        volumeType: ec2.EbsDeviceVolumeType.GP2,
                    }),
                },
            ],
        });
    }
    createUserDataScript(database, config) {
        const userData = ec2.UserData.forLinux();
        userData.addCommands(
        // Install Docker and Docker Compose
        "yum update -y", "yum install -y docker htop jq", "systemctl start docker", "systemctl enable docker", "usermod -a -G docker ec2-user", 
        // Install Docker Compose
        'curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose', "chmod +x /usr/local/bin/docker-compose", 
        // Create app directory
        "mkdir -p /opt/app", "cd /opt/app", 
        // Create docker-compose.yml with all environment variables
        'cat > /opt/app/docker-compose.yml << "EOF"', this.createDockerCompose(database, config), "EOF", 
        // Create .env file setup script
        'cat > /opt/app/setup-env.sh << "EOF"', this.createEnvSetupScript(database), "EOF", "chmod +x /opt/app/setup-env.sh", 
        // Run setup and start application
        "/opt/app/setup-env.sh", "docker-compose pull", "docker-compose up -d", 
        // Create health check script
        'cat > /opt/app/health-check.sh << "EOF"', "#!/bin/bash", "curl -f http://localhost || exit 1", "EOF", "chmod +x /opt/app/health-check.sh");
        return userData;
    }
    createDockerCompose(database, config) {
        return `version: '3.8'
services:
  app:
    image: docker.io/joshcutts/error-analysis-app:latest
    network_mode: host
    environment:
      - DB_HOST=\${DB_HOST}
      - DB_PORT=5432
      - DB_USER=\${DB_USER}
      - DB_PASSWORD=\${DB_PASSWORD}
      - DB_NAME=error_analysis
      - NODE_ENV=production
      - DB_SSL=true
      - PGSSLMODE=require
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - OPEN_API_KEY=${config.openApiKey}
      - PHOENIX_API_KEY=${config.phoenixApiKey}
      - PHOENIX_API_URL=${config.phoenixApiUrl}
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"`;
    }
    createEnvSetupScript(database) {
        return `#!/bin/bash
# Get database credentials from AWS Secrets Manager
echo "Getting database credentials..."

DB_SECRET=$(aws secretsmanager get-secret-value --secret-id ${database.secret?.secretName || "db-secret"} --region \${AWS_REGION:-us-west-2} --query SecretString --output text)

DB_HOST=$(echo $DB_SECRET | jq -r .host)
DB_USER=$(echo $DB_SECRET | jq -r .username)
DB_PASSWORD=$(echo $DB_SECRET | jq -r .password)

# Create .env file
cat > .env << ENVEOF
DB_HOST=$DB_HOST
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
ENVEOF

echo "Database credentials configured successfully"
echo "DB Host: $DB_HOST"
echo "DB User: $DB_USER"
`;
    }
    createOutputs(config, appInstance, database) {
        new cdk.CfnOutput(this, "AppInstanceId", {
            value: appInstance.instanceId,
            description: "Application Instance ID",
        });
        new cdk.CfnOutput(this, "AppPrivateIp", {
            value: appInstance.instancePrivateIp,
            description: "Application Private IP",
        });
        new cdk.CfnOutput(this, "AppUrl", {
            value: `http://${appInstance.instancePrivateIp}`,
            description: "Application URL (connect via VPN first)",
        });
        new cdk.CfnOutput(this, "DatabaseEndpoint", {
            value: database.instanceEndpoint.hostname,
            description: "Database Endpoint",
        });
        new cdk.CfnOutput(this, "DatabaseSecretArn", {
            value: database.secret?.secretArn || "N/A",
            description: "Database Secret ARN",
        });
        new cdk.CfnOutput(this, "AccessInstructions", {
            value: [
                "1. Connect to your VPN",
                `2. Access app at http://${appInstance.instancePrivateIp}`,
                "3. Use /health endpoint to verify the app is running",
                "4. SSH access via AWS Session Manager (no key needed)",
            ].join(" | "),
            description: "How to access your application",
        });
    }
}
exports.AppDeploymentStack = AppDeploymentStack;
// CLI Implementation
class DeploymentCLI {
    constructor() {
        this.program = new commander_1.Command();
        this.setupCommands();
    }
    setupCommands() {
        this.program
            .name("deploy-app")
            .description("Deploy error analysis application to AWS with VPN access")
            .version("1.0.0");
        this.program
            .command("deploy")
            .description("Deploy application infrastructure")
            .option("-i, --interactive", "Interactive configuration")
            .action(this.handleDeploy.bind(this));
    }
    async handleDeploy(options) {
        console.log("🚀 Starting Error Analysis App deployment...\n");
        const config = await this.getInteractiveConfig();
        console.log("\n📋 Deployment Summary:");
        console.log(`👤 AWS Profile: ${config.awsProfile}`);
        console.log(`📱 App Name: ${config.appName}`);
        console.log(`🏷️  Environment: ${config.environment}`);
        console.log(`🌐 VPC: ${config.vpcId}`);
        console.log(`🔒 Private Subnets: Auto-detected from VPC`);
        console.log(`🔐 VPN CIDR Blocks: ${config.vpnCidrBlocks.join(", ")}`);
        console.log(`🐳 Docker Image: docker.io/joshcutts/error-analysis-app:latest`);
        console.log(`🔑 API Keys: OpenAI ✓, Phoenix ✓\n`);
        const proceed = await inquirer_1.default.prompt([
            {
                type: "confirm",
                name: "proceed",
                message: "Proceed with deployment?",
                default: true,
            },
        ]);
        if (proceed.proceed) {
            try {
                await this.deployStack(config);
            }
            catch (error) {
                console.log(`\n❌ Deployment failed: ${error instanceof Error ? error.message : error}`);
                console.log("\n💡 Troubleshooting tips:");
                console.log(`   • Ensure AWS credentials are configured for profile: aws configure --profile ${config.awsProfile}`);
                console.log(`   • Check if the VPC (${config.vpcId}) exists and has private subnets in your AWS account`);
                console.log(`   • Verify the selected profile (${config.awsProfile}) has the necessary permissions`);
                console.log("   • Make sure your VPN CIDR blocks are correct");
                process.exit(1);
            }
        }
        else {
            console.log("Deployment cancelled.");
        }
    }
    async getInteractiveConfig() {
        console.log("📝 Let's configure your Error Analysis App deployment:\n");
        // Get available AWS profiles
        const availableProfiles = await this.getAvailableProfiles();
        const currentProfile = process.env.AWS_PROFILE || 'default';
        // First, get the AWS profile
        const profileAnswer = await inquirer_1.default.prompt([
            {
                type: "list",
                name: "awsProfile",
                message: "Select AWS Profile:",
                choices: availableProfiles,
                default: availableProfiles.includes(currentProfile) ? currentProfile : availableProfiles[0],
            }
        ]);
        console.log(`\n🔍 Detecting VPCs in your AWS account...`);
        const availableVpcs = await this.getAvailableVpcs(profileAnswer.awsProfile);
        const restOfAnswers = await inquirer_1.default.prompt([
            {
                type: "input",
                name: "appName",
                message: "Application name (lowercase, hyphens only):",
                validate: (input) => /^[a-z0-9-]+$/.test(input) ||
                    "Use lowercase letters, numbers, and hyphens only",
                default: "error-analysis-app",
            },
            {
                type: "list",
                name: "environment",
                message: "Environment:",
                choices: ["dev", "staging", "prod"],
                default: "dev",
            },
            {
                type: availableVpcs[0].id === 'vpc-manual-input' ? "input" : "list",
                name: "vpcId",
                message: availableVpcs[0].id === 'vpc-manual-input' ? "VPC ID (vpc-xxxxxxxxx):" : "Select VPC:",
                choices: availableVpcs[0].id === 'vpc-manual-input' ? undefined : availableVpcs.map(vpc => ({
                    name: vpc.display,
                    value: vpc.id
                })),
                validate: availableVpcs[0].id === 'vpc-manual-input' ?
                    (input) => input.startsWith("vpc-") || "VPC ID must start with vpc-" :
                    undefined,
            },
            {
                type: "input",
                name: "vpnCidrBlocks",
                message: "VPN CIDR blocks (comma-separated):",
                filter: (input) => input.split(",").map((s) => s.trim()),
                validate: (input) => input.length >= 1 || "At least one VPN CIDR block required",
            },
            {
                type: "password",
                name: "openApiKey",
                message: "OpenAI API Key:",
                mask: "*",
                validate: (input) => input.length > 0 || "OpenAI API Key is required",
            },
            {
                type: "password",
                name: "phoenixApiKey",
                message: "Phoenix API Key:",
                mask: "*",
                validate: (input) => input.length > 0 || "Phoenix API Key is required",
            },
            {
                type: "input",
                name: "phoenixApiUrl",
                message: "Phoenix API URL:",
                validate: (input) => input.startsWith("http") || "Please enter a valid URL",
                default: "https://api.phoenix.com",
            },
        ]);
        // Combine all answers
        const allAnswers = { ...profileAnswer, ...restOfAnswers };
        return {
            ...allAnswers,
            vpnCidrBlocks: typeof allAnswers.vpnCidrBlocks === "string"
                ? [allAnswers.vpnCidrBlocks]
                : allAnswers.vpnCidrBlocks,
        };
    }
    async getAvailableProfiles() {
        try {
            const { stdout } = await execAsync('aws configure list-profiles');
            return stdout.trim().split('\n').filter(profile => profile.length > 0);
        }
        catch (error) {
            console.log("⚠️  Could not detect AWS profiles. Make sure AWS CLI is installed.");
            return ['default'];
        }
    }
    async getAvailableVpcs(profile) {
        try {
            // Get the region for this profile
            const region = await this.getProfileRegion(profile);
            const { stdout } = await execAsync(`aws ec2 describe-vpcs --profile ${profile} --region ${region}`);
            const vpcs = JSON.parse(stdout);
            return vpcs.Vpcs.map((vpc) => {
                // Find the Name tag
                const nameTag = vpc.Tags?.find((tag) => tag.Key === 'Name');
                const name = nameTag ? nameTag.Value : 'No Name';
                const cidr = vpc.CidrBlock;
                const isDefault = vpc.IsDefault ? ' (Default)' : '';
                return {
                    id: vpc.VpcId,
                    name: name,
                    display: `${vpc.VpcId} - ${name} (${cidr})${isDefault}`,
                    region: region
                };
            }).sort((a, b) => {
                // Sort default VPC first, then by name
                if (a.display.includes('(Default)'))
                    return -1;
                if (b.display.includes('(Default)'))
                    return 1;
                return a.name.localeCompare(b.name);
            });
        }
        catch (error) {
            console.log("⚠️  Could not detect VPCs. Make sure you have EC2 permissions.");
            return [{
                    id: 'vpc-manual-input',
                    name: 'Manual Input Required',
                    display: 'Could not auto-detect - you\'ll need to enter manually',
                    region: 'us-west-2'
                }];
        }
    }
    async getProfileRegion(profile) {
        try {
            // Try to get region from AWS CLI config
            const { stdout } = await execAsync(`aws configure get region --profile ${profile}`);
            const region = stdout.trim();
            return region || 'us-west-2'; // fallback to us-west-2
        }
        catch (error) {
            // If that fails, try to get default region
            try {
                const { stdout } = await execAsync(`aws configure get region`);
                return stdout.trim() || 'us-west-2';
            }
            catch (error2) {
                return process.env.AWS_DEFAULT_REGION || 'us-west-2';
            }
        }
    }
    async isBootstrapped(profile) {
        try {
            const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${profile}`);
            const identity = JSON.parse(stdout);
            const account = identity.Account;
            const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';
            // Check if bootstrap stack exists
            const { stdout: stacks } = await execAsync(`aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --profile ${profile} --region ${region}`);
            const stackList = JSON.parse(stacks);
            return stackList.StackSummaries.some((stack) => stack.StackName.startsWith('CDKToolkit'));
        }
        catch (error) {
            return false;
        }
    }
    async bootstrapCdk(profile) {
        console.log(`🔧 Bootstrapping CDK for profile: ${profile}...`);
        // Temporarily rename cdk.json to avoid conflicts
        const cdkJsonExists = await fs_1.promises.access('cdk.json').then(() => true).catch(() => false);
        if (cdkJsonExists) {
            await fs_1.promises.rename('cdk.json', 'cdk.json.tmp');
        }
        try {
            const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${profile}`);
            const identity = JSON.parse(stdout);
            const account = identity.Account;
            const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';
            console.log(`📍 Account: ${account}`);
            console.log(`🌎 Region: ${region}`);
            // Run bootstrap command
            await new Promise((resolve, reject) => {
                const bootstrap = (0, child_process_1.spawn)('npx', ['--package', 'aws-cdk', 'cdk', 'bootstrap',
                    `aws://${account}/${region}`, '--profile', profile], {
                    stdio: 'inherit',
                    shell: true,
                });
                bootstrap.on('close', (code) => {
                    if (code === 0) {
                        console.log('✅ Bootstrap completed successfully!');
                        resolve();
                    }
                    else {
                        reject(new Error(`Bootstrap failed with exit code ${code}`));
                    }
                });
                bootstrap.on('error', (error) => {
                    reject(error);
                });
            });
        }
        finally {
            // Restore cdk.json
            if (cdkJsonExists) {
                await fs_1.promises.rename('cdk.json.tmp', 'cdk.json');
            }
        }
    }
    async deployStack(config) {
        console.log("\n🏗️  Creating CDK application...");
        try {
            // Set the AWS profile environment variable for all AWS operations
            const originalAwsProfile = process.env.AWS_PROFILE;
            process.env.AWS_PROFILE = config.awsProfile;
            console.log(`👤 Using AWS Profile: ${config.awsProfile}`);
            // Check if CDK is bootstrapped for this profile
            const isBootstrapped = await this.isBootstrapped(config.awsProfile);
            if (!isBootstrapped) {
                console.log("⚡ CDK not bootstrapped for this profile. Bootstrapping automatically...");
                await this.bootstrapCdk(config.awsProfile);
            }
            else {
                console.log("✅ CDK already bootstrapped for this profile");
            }
            // Get account and region after ensuring bootstrap
            const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${config.awsProfile}`);
            const identity = JSON.parse(stdout);
            const account = identity.Account;
            const region = await this.getProfileRegion(config.awsProfile);
            console.log(`📍 Account: ${account}`);
            console.log(`🌎 Region: ${region}`);
            // Set environment variables that CDK needs for context
            process.env.CDK_DEFAULT_ACCOUNT = account;
            process.env.CDK_DEFAULT_REGION = region;
            const app = new cdk.App();
            const stackName = `${config.appName}-${config.environment}-stack`;
            // CDK needs explicit account/region for VPC lookup
            console.log(`🔍 Looking up VPC ${config.vpcId} in account ${account}, region ${region}`);
            console.log(`🔧 Environment variables set: CDK_DEFAULT_ACCOUNT=${process.env.CDK_DEFAULT_ACCOUNT}, CDK_DEFAULT_REGION=${process.env.CDK_DEFAULT_REGION}`);
            new AppDeploymentStack(app, stackName, config, {
                env: {
                    account: account,
                    region: region
                },
            });
            console.log(`\n📦 Stack created: ${stackName}`);
            console.log("⚡ Synthesizing CloudFormation templates...");
            // Synthesize the CDK app to generate CloudFormation templates
            const cloudAssembly = app.synth();
            console.log(`📁 CloudFormation templates written to: ${cloudAssembly.directory}`);
            console.log("✅ Synthesis completed successfully");
            console.log("🚀 Starting deployment...");
            console.log("🐳 Docker image: docker.io/joshcutts/error-analysis-app:latest");
            // Deploy using CDK CLI with selected AWS profile
            const assemblyDir = cloudAssembly.directory;
            return new Promise(async (resolve, reject) => {
                const profileFlag = ["--profile", config.awsProfile];
                console.log(`Running: npx --package aws-cdk cdk deploy ${stackName} --require-approval never --app ${assemblyDir} --profile ${config.awsProfile}`);
                // Temporarily rename cdk.json to avoid conflicts during deployment
                const cdkJsonExists = await fs_1.promises.access('cdk.json').then(() => true).catch(() => false);
                if (cdkJsonExists) {
                    await fs_1.promises.rename('cdk.json', 'cdk.json.tmp');
                }
                try {
                    // Use npx with --package flag to ensure we get the real AWS CDK
                    // Point to the synthesized CloudFormation templates
                    const cdkDeploy = (0, child_process_1.spawn)("npx", ["--package", "aws-cdk", "cdk", "deploy", stackName, "--require-approval", "never", "--app", assemblyDir, ...profileFlag], {
                        stdio: "inherit",
                        shell: true,
                    });
                    cdkDeploy.on("close", async (code) => {
                        // Restore cdk.json
                        if (cdkJsonExists) {
                            await fs_1.promises.rename('cdk.json.tmp', 'cdk.json');
                        }
                        if (code === 0) {
                            console.log("\n✅ Deployment completed successfully!");
                            console.log("\n💡 Monitor your application in AWS CloudFormation console");
                            console.log("🔗 Connect to VPN and access your app via the private IP shown in outputs");
                            console.log("🏥 Use /health endpoint to verify the app is running");
                            resolve();
                        }
                        else {
                            console.log(`\n❌ CDK deployment process exited with code ${code}`);
                            reject(new Error(`CDK deployment failed with exit code ${code}`));
                        }
                    });
                    cdkDeploy.on("error", async (error) => {
                        // Restore cdk.json on error
                        if (cdkJsonExists) {
                            await fs_1.promises.rename('cdk.json.tmp', 'cdk.json');
                        }
                        console.log(`\n❌ Error launching CDK deployment: ${error.message}`);
                        reject(error);
                    });
                }
                catch (fileError) {
                    // Restore cdk.json on any file operation error
                    if (cdkJsonExists) {
                        await fs_1.promises.rename('cdk.json.tmp', 'cdk.json').catch(() => { });
                    }
                    reject(fileError);
                }
            });
        }
        catch (synthError) {
            console.log(`\n❌ Error during CDK synthesis: ${synthError instanceof Error ? synthError.message : synthError}`);
            throw synthError;
        }
    }
    run() {
        this.program.parse();
    }
}
// Run CLI if executed directly
if (require.main === module) {
    const cli = new DeploymentCLI();
    cli.run();
}
