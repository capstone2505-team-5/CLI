#!/usr/bin/env node
// deploy-app.ts

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as cr from "aws-cdk-lib/custom-resources";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import inquirer from "inquirer";
import { Command } from "commander";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from 'path';

const execAsync = promisify(exec);

// Configuration interface
interface DeploymentConfig {
  appName: string;
  vpcId: string;
  vpnCidrBlocks: string[];
  openApiKey: string;
  phoenixApiKey: string;
  phoenixApiUrl: string;
  
  // AWS Profile
  awsProfile: string;
  
  // Optional detected subnets and AZs
  detectedPrivateSubnets?: string[];
  detectedAvailabilityZones?: string[];
}

// Main deployment stack
export class AppDeploymentStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    config: DeploymentConfig,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // Import existing VPC directly without lookup (more reliable)
    // Use the actual AZs where private subnets exist
    const azs = config.detectedAvailabilityZones && config.detectedAvailabilityZones.length > 0
      ? config.detectedAvailabilityZones
      : props?.env?.region ? 
        [`${props.env.region}a`, `${props.env.region}b`] :
        ['us-west-2a', 'us-west-2b'];
      
    const vpc = ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
      vpcId: config.vpcId,
      availabilityZones: azs,
      privateSubnetIds: config.detectedPrivateSubnets || [],
    });

    // Use the detected private subnets
    const privateSubnetSelection: ec2.SubnetSelection = config.detectedPrivateSubnets && config.detectedPrivateSubnets.length > 0 
      ? { subnetFilters: [ec2.SubnetFilter.byIds(config.detectedPrivateSubnets)] }
      : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    // Create security groups
    const { appSecurityGroup, dbSecurityGroup } = this.createSecurityGroups(
      vpc,
      config
    );

    // Create RDS database
    const database = this.createDatabase(
      vpc,
      privateSubnetSelection,
      dbSecurityGroup,
      config
    );

    // Create API secrets
    const apiSecrets = this.createApiSecrets(config);

    // Create shared Lambda security group
    const lambdaSecurityGroup = this.createLambdaSecurityGroup(vpc);

    // Create EC2 instance with Docker
    const appInstance = this.createAppInstance(
      vpc,
      privateSubnetSelection,
      appSecurityGroup,
      database,
      config
    );
    
    // Create Lambda function for getting all project root spans
    const getAllProjectRootSpansLambda = this.createGetAllProjectRootSpansLambda(
      vpc,
      privateSubnetSelection,
      database,
      apiSecrets,
      lambdaSecurityGroup,
      config
    );

    // Create Lambda function for getting all projects
    const getAllProjectsLambda = this.createGetAllProjectsLambda(
      vpc,
      privateSubnetSelection,
      database,
      apiSecrets,
      getAllProjectRootSpansLambda,
      lambdaSecurityGroup,
      config
    );

    // Create Lambda function for database creation
    const dbCreationLambda = this.createDbCreationLambda(
      vpc,
      privateSubnetSelection,
      database,
      lambdaSecurityGroup,
      config
    );

    // Trigger Lambda function at the end of deployment
    this.triggerDbCreationLambda(dbCreationLambda, database, getAllProjectsLambda);

    // Create CloudWatch rules for data population
    this.createDataPopulationRules(getAllProjectsLambda, database, dbCreationLambda);

    // Create outputs
    this.createOutputs(config, appInstance, database, dbCreationLambda, getAllProjectRootSpansLambda, getAllProjectsLambda, apiSecrets);
  }

  private createSecurityGroups(vpc: ec2.IVpc, config: DeploymentConfig) {
    // Application security group
    const appSecurityGroup = new ec2.SecurityGroup(this, "AppSecurityGroup", {
      vpc,
      description: `Security group for ${config.appName}`,
      allowAllOutbound: true,
    });

    // Allow access from VPN networks
    config.vpnCidrBlocks.forEach((cidr, index) => {
      appSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        `HTTP from VPN network ${index + 1}: ${cidr}`
      );

      appSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(22),
        `SSH from VPN network ${index + 1}: ${cidr}`
      );
    });

    // Database security group
    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      "DatabaseSecurityGroup",
      {
        vpc,
        description: "Security group for database",
        allowAllOutbound: false,
      }
    );

    dbSecurityGroup.addIngressRule(
      appSecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL from app instances"
    );

    return { appSecurityGroup, dbSecurityGroup };
  }

  private createDatabase(
    vpc: ec2.IVpc,
    subnetSelection: ec2.SubnetSelection,
    securityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ): rds.DatabaseInstance {
    const dbSubnetGroup = new rds.SubnetGroup(this, "DatabaseSubnetGroup", {
      vpc,
      description: "Subnet group for RDS database",
      vpcSubnets: subnetSelection,
    });

    return new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15_8,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ), // Free tier
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

  private createAppInstance(
    vpc: ec2.IVpc,
    subnetSelection: ec2.SubnetSelection,
    securityGroup: ec2.SecurityGroup,
    database: rds.DatabaseInstance,
    config: DeploymentConfig
  ): ec2.Instance {
    // Create IAM role for EC2
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "CloudWatchAgentServerPolicy"
        ),
      ],
    });

    // Grant access to database secret
    database.secret?.grantRead(instanceRole);

    // Create user data script
    const userData = this.createUserDataScript(database, config);

    return new ec2.Instance(this, "AppInstance", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ), // Free tier
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

  private createUserDataScript(
    database: rds.DatabaseInstance,
    config: DeploymentConfig
  ): ec2.UserData {
    const userData = ec2.UserData.forLinux();

    userData.addCommands(
      // Install Docker and Docker Compose
      "yum update -y",
      "yum install -y docker htop jq",
      "systemctl start docker",
      "systemctl enable docker",
      "usermod -a -G docker ec2-user",

      // Install Docker Compose
      'curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose',
      "chmod +x /usr/local/bin/docker-compose",
      "/usr/local/bin/docker-compose --version",

      // Create app directory
      "mkdir -p /opt/app",
      "cd /opt/app",

      // Create docker-compose.yml with all environment variables
      'cat > /opt/app/docker-compose.yml << "EOF"',
      this.createDockerCompose(database, config),
      "EOF",

      // Create .env file setup script
      'cat > /opt/app/setup-env.sh << "EOF"',
      this.createEnvSetupScript(database),
      "EOF",
      "chmod +x /opt/app/setup-env.sh",

      // Run setup and start application
      "/opt/app/setup-env.sh",
      "echo 'Starting docker-compose deployment...'",
      "/usr/local/bin/docker-compose pull",
      "/usr/local/bin/docker-compose up -d",
      "echo 'Docker containers started. Checking status...'",
      "/usr/local/bin/docker-compose ps",

      // Create health check script
      'cat > /opt/app/health-check.sh << "EOF"',
      "#!/bin/bash",
      "curl -f http://localhost || exit 1",
      "EOF",
      "chmod +x /opt/app/health-check.sh"
    );

    return userData;
  }

  private createDockerCompose(
    database: rds.DatabaseInstance,
    config: DeploymentConfig
  ): string {
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
      - OPENAI_API_KEY=${config.openApiKey}
      - PHOENIX_API_KEY=${config.phoenixApiKey}
      - PHOENIX_API_URL=${config.phoenixApiUrl}
    restart: always
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"`;
  }

  private createEnvSetupScript(database: rds.DatabaseInstance): string {
    return `#!/bin/bash
# Get database credentials from AWS Secrets Manager
echo "Getting database credentials..."

DB_SECRET=$(aws secretsmanager get-secret-value --secret-id ${
      database.secret?.secretName || "db-secret"
    } --region \${AWS_REGION:-us-west-2} --query SecretString --output text)

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

  private createOutputs(
    config: DeploymentConfig,
    appInstance: ec2.Instance,
    database: rds.DatabaseInstance,
    dbCreationLambda?: lambda.Function,
    getAllProjectRootSpansLambda?: lambda.Function,
    getAllProjectsLambda?: lambda.Function,
    apiSecrets?: secretsmanager.Secret
  ) {
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

    // Add Lambda outputs if they exist
    if (dbCreationLambda) {
      new cdk.CfnOutput(this, "RDSTableCreation", {
        value: dbCreationLambda.functionName,
        description: "Creates RDS tables",
      });

      new cdk.CfnOutput(this, "RDSTableCreationArn", {
        value: dbCreationLambda.functionArn,
        description: "Database Creation Lambda Function ARN",
      });
    }

    if (getAllProjectRootSpansLambda) {
      new cdk.CfnOutput(this, "GetAllProjectRootSpans", {
        value: getAllProjectRootSpansLambda.functionName,
        description: "Gets all project root spans",
      });

      new cdk.CfnOutput(this, "GetAllProjectRootSpansArn", {
        value: getAllProjectRootSpansLambda.functionArn,
        description: "Get All Project Root Spans Lambda Function ARN",
      });
    }

    if (getAllProjectsLambda) {
      new cdk.CfnOutput(this, "GetAllProjects", {
        value: getAllProjectsLambda.functionName,
        description: "Gets all projects",
      });

      new cdk.CfnOutput(this, "GetAllProjectsArn", {
        value: getAllProjectsLambda.functionArn,
        description: "Get All Projects Lambda Function ARN",
      });
    }

    // Add API secrets output
    if (apiSecrets) {
      new cdk.CfnOutput(this, "ApiSecretsArn", {
        value: apiSecrets.secretArn,
        description: "API Keys Secret ARN",
      });
    }
  }

  private createDbCreationLambda(
    vpc: ec2.IVpc,
    subnetSelection: ec2.SubnetSelection,
    database: rds.DatabaseInstance,
    lambdaSecurityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ): lambda.Function {
    // Allow Lambda to access RDS
    database.connections.allowFrom(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      "Allow Lambda to access RDS"
    );

    // Create IAM role for Lambda
    const lambdaRole = new iam.Role(this, "DbCreationLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    // Add custom policy for GetProjectRootSpans Lambda invocation
    const invokePolicy = new iam.Policy(this, "InvokeGetProjectRootSpansPolicy", {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: ["arn:aws:lambda:*:*:function:GetProjectRootSpans"],
        }),
      ],
    });
    lambdaRole.attachInlinePolicy(invokePolicy);

    // Create Lambda function
    const lambdaFunction = new lambdaNodejs.NodejsFunction(this, "DbCreationLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/dbCreation/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: subnetSelection,
      securityGroups: [lambdaSecurityGroup],
      role: lambdaRole,
      environment: {
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || "error-analysis-app-db-credentials",
        NODE_ENV: "production",
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    return lambdaFunction;
  }

  private createGetAllProjectRootSpansLambda(
    vpc: ec2.IVpc,
    subnetSelection: ec2.SubnetSelection,
    database: rds.DatabaseInstance,
    apiSecrets: secretsmanager.Secret,
    lambdaSecurityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ): lambda.Function {
    // Create IAM role for Lambda
    const lambdaRole = new iam.Role(this, "GetAllProjectRootSpansLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    // Grant access to API secrets
    apiSecrets.grantRead(lambdaRole);

    // Create Lambda function
    const lambdaFunction = new lambdaNodejs.NodejsFunction(this, "GetAllProjectRootSpansLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/ingestProject/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: subnetSelection,
      securityGroups: [lambdaSecurityGroup],
      role: lambdaRole,
      environment: {
        NODE_ENV: "production",
        PHOENIX_API_URL: config.phoenixApiUrl,
        PHOENIX_API_KEY_SECRET_NAME: apiSecrets.secretName,
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || "error-analysis-app-db-credentials",
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    return lambdaFunction;
  }

  private createGetAllProjectsLambda(
    vpc: ec2.IVpc,
    subnetSelection: ec2.SubnetSelection,
    database: rds.DatabaseInstance,
    apiSecrets: secretsmanager.Secret,
    getAllProjectRootSpansLambda: lambda.Function,
    lambdaSecurityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ): lambda.Function {
    // Create IAM role for Lambda
    const lambdaRole = new iam.Role(this, "GetAllProjectsLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    // Grant access to API secrets
    apiSecrets.grantRead(lambdaRole);

    // Add custom policy for invoking GetAllProjectRootSpans Lambda
    const invokePolicy = new iam.Policy(this, "InvokeGetAllProjectRootSpansPolicy", {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["lambda:InvokeFunction"],
          resources: [getAllProjectRootSpansLambda.functionArn],
        }),
      ],
    });
    lambdaRole.attachInlinePolicy(invokePolicy);

    // Create Lambda function
    const lambdaFunction = new lambdaNodejs.NodejsFunction(this, "GetAllProjectsLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/entry/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: subnetSelection,
      securityGroups: [lambdaSecurityGroup],
      role: lambdaRole,
      environment: {
        NODE_ENV: "production",
        PHOENIX_API_URL: config.phoenixApiUrl,
        PHOENIX_API_KEY_SECRET_NAME: apiSecrets.secretName,
        SPAN_INGESTION_ARN: getAllProjectRootSpansLambda.functionArn,
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || "error-analysis-app-db-credentials",
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    return lambdaFunction;
  }

  private createLambdaSecurityGroup(vpc: ec2.IVpc): ec2.SecurityGroup {
    // Create a shared security group for all Lambda functions
    return new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc,
      description: "Security group for Lambda functions",
      allowAllOutbound: true,
    });
  }

  private createApiSecrets(config: DeploymentConfig): secretsmanager.Secret {
    // Create a secret for API keys
    const apiSecret = new secretsmanager.Secret(this, "ApiKeysSecret", {
      secretName: `${config.appName}-api-keys`,
      description: "API keys for Error Analysis application",
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        openaiApiKey: config.openApiKey,
        phoenixApiKey: config.phoenixApiKey,
      })),
    });

    return apiSecret;
  }

  private createDataPopulationRules(getAllProjectsLambda: lambda.Function, database: rds.DatabaseInstance, dbCreationLambda: lambda.Function) {
    // Ongoing updates - runs every 5 minutes
    // Note: targets.LambdaFunction automatically creates the necessary permissions
    const ongoingRule = new events.Rule(this, "OngoingDataUpdatesRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(getAllProjectsLambda)],
      description: "Ongoing data updates every 5 minutes",
    });

    // Ensure ongoing rule waits for database and Lambda to be ready
    ongoingRule.node.addDependency(database);
    ongoingRule.node.addDependency(getAllProjectsLambda);
  }

  private triggerDbCreationLambda(lambdaFunction: lambda.Function, database: rds.DatabaseInstance, getAllProjectsLambda?: lambda.Function) {
    // Create a custom resource that invokes the Lambda function only on create
    const trigger = new cr.AwsCustomResource(this, "DbCreationTrigger", {
      onCreate: {
        service: "Lambda",
        action: "invoke",
        parameters: {
          FunctionName: lambdaFunction.functionName,
          InvocationType: "RequestResponse",
          Payload: JSON.stringify({
            action: "CREATE",
            timestamp: new Date().toISOString(),
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of("DbCreationTrigger"),
      },
      // No onUpdate - only run on initial creation
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [lambdaFunction.functionArn],
        }),
      ]),
    });

    // Ensure the trigger waits for the database to be ready
    trigger.node.addDependency(database);

    // If getAllProjectsLambda is provided, trigger initial data load after DB creation
    if (getAllProjectsLambda) {
      const initialDataLoadTrigger = new cr.AwsCustomResource(this, "InitialDataLoadTrigger", {
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: getAllProjectsLambda.functionName,
            InvocationType: "Event", // Asynchronous
            Payload: JSON.stringify({
              action: "INITIAL_LOAD",
              timestamp: new Date().toISOString(),
            }),
          },
          physicalResourceId: cr.PhysicalResourceId.of("InitialDataLoadTrigger"),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["lambda:InvokeFunction"],
            resources: [getAllProjectsLambda.functionArn],
          }),
        ]),
      });

      // Ensure initial data load waits for DB creation to complete
      initialDataLoadTrigger.node.addDependency(trigger);
    }
  }
}

// CLI Implementation
class DeploymentCLI {
  private program: Command;

  constructor() {
    this.program = new Command();
    this.setupCommands();
  }

  private setupCommands() {
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

  private async handleDeploy(options: any) {
    console.log("🚀 Starting Error Analysis App deployment...\n");

    const config = await this.getInteractiveConfig();

    console.log("\n📋 Deployment Summary:");
    console.log(`👤 AWS Profile: ${config.awsProfile}`);
    console.log(`📱 App Name: ${config.appName}`);
    console.log(`🌐 VPC: ${config.vpcId}`);
    console.log(`🔒 Private Subnets: Auto-detected from VPC`);
    console.log(`🔐 VPN CIDR Blocks: ${config.vpnCidrBlocks.join(", ")}`);
    console.log(`🐳 Docker Image: docker.io/joshcutts/error-analysis-app:latest`);
    console.log(`🔑 API Keys: OpenAI ✓, Phoenix ✓`);
    console.log(`⚡ Lambda: Database Creation (Node.js 22.x, 30s timeout)\n`);

    const proceed = await inquirer.prompt([
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
      } catch (error) {
        console.log(`\n❌ Deployment failed: ${error instanceof Error ? error.message : error}`);
        console.log("\n💡 Troubleshooting tips:");
        console.log(`   • Ensure AWS credentials are configured for profile: aws configure --profile ${config.awsProfile}`);
        console.log(`   • Check if the VPC (${config.vpcId}) exists and has private subnets in your AWS account`);
        console.log(`   • Verify the selected profile (${config.awsProfile}) has the necessary permissions`);
        console.log("   • Make sure your VPN CIDR blocks are correct");
        process.exit(1);
      }
    } else {
      console.log("Deployment cancelled.");
    }
  }

  private async getInteractiveConfig(): Promise<DeploymentConfig> {
    console.log("📝 Let's configure your Error Analysis App deployment:\n");

    // Get available AWS profiles
    const availableProfiles = await this.getAvailableProfiles();
    const currentProfile = process.env.AWS_PROFILE || 'default';

    // First, get the AWS profile
    const profileAnswer = await inquirer.prompt([
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

    const restOfAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "appName",
        message: "Application name (lowercase, hyphens only):",
        validate: (input: string) =>
          /^[a-z0-9-]+$/.test(input) ||
          "Use lowercase letters, numbers, and hyphens only",
        default: "error-analysis-app",
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
          (input: string) => /^vpc-[a-z0-9]+$/.test(input) || "Enter valid VPC ID" :
          undefined,
      },
      {
        type: "input",
        name: "vpnCidrBlocks",
        message: "VPN CIDR blocks (comma-separated):",
        filter: (input: string) => input.split(",").map((s: string) => s.trim()),
        validate: (input: string[]) =>
          input.length >= 1 || "At least one VPN CIDR block required",
      },
      {
        type: "password",
        name: "openApiKey",
        message: "OpenAI API Key:",
        mask: "*",
        validate: (input: string) => input.length > 0 || "OpenAI API Key is required",
      },
      {
        type: "password",
        name: "phoenixApiKey",
        message: "Phoenix API Key:",
        mask: "*",
        validate: (input: string) => input.length > 0 || "Phoenix API Key is required",
      },
      {
        type: "input",
        name: "phoenixApiUrl",
        message: "Phoenix API URL:",
        validate: (input: string) =>
          input.startsWith("http") || "Please enter a valid URL",
        default: "https://api.phoenix.com",
      },
    ]);

    // Combine all answers
    const allAnswers = { ...profileAnswer, ...restOfAnswers };
    
    return {
      ...allAnswers,
      vpnCidrBlocks:
        typeof allAnswers.vpnCidrBlocks === "string"
          ? [allAnswers.vpnCidrBlocks]
          : allAnswers.vpnCidrBlocks,
    };
  }

  private async getAvailableProfiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('aws configure list-profiles');
      return stdout.trim().split('\n').filter(profile => profile.length > 0);
    } catch (error) {
      console.log("⚠️  Could not detect AWS profiles. Make sure AWS CLI is installed.");
      return ['default'];
    }
  }

  private async getAvailableVpcs(profile: string): Promise<Array<{id: string, name: string, display: string, region: string}>> {
    try {
      // Get the region for this profile
      const region = await this.getProfileRegion(profile);
      
      const { stdout } = await execAsync(`aws ec2 describe-vpcs --profile ${profile} --region ${region}`);
      const vpcs = JSON.parse(stdout);
      
      return vpcs.Vpcs.map((vpc: any) => {
        // Find the Name tag
        const nameTag = vpc.Tags?.find((tag: any) => tag.Key === 'Name');
        const name = nameTag ? nameTag.Value : 'No Name';
        const cidr = vpc.CidrBlock;
        const isDefault = vpc.IsDefault ? ' (Default)' : '';
        
        return {
          id: vpc.VpcId,
          name: name,
          display: `${vpc.VpcId} - ${name} (${cidr})${isDefault}`,
          region: region
        };
      }).sort((a: any, b: any) => {
        // Sort default VPC first, then by name
        if (a.display.includes('(Default)')) return -1;
        if (b.display.includes('(Default)')) return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (error) {
      console.log("⚠️  Could not detect VPCs. Make sure you have EC2 permissions.");
      return [{
        id: 'vpc-manual-input',
        name: 'Manual Input Required',
        display: 'Could not auto-detect - you\'ll need to enter manually',
        region: 'us-west-2'
      }];
    }
  }

  private async getPrivateSubnets(vpcId: string, profile: string): Promise<{subnetIds: string[], availabilityZones: string[]}> {
    try {
      const region = await this.getProfileRegion(profile);
      const { stdout } = await execAsync(`aws ec2 describe-subnets --filters "Name=vpc-id,Values=${vpcId}" --profile ${profile} --region ${region}`);
      const subnets = JSON.parse(stdout);
      
      // Find private subnets (subnets without direct internet gateway route)
      const privateSubnetsWithAZ: Array<{subnetId: string, az: string}> = [];
      
      for (const subnet of subnets.Subnets) {
        try {
          // Check route table for this subnet to see if it has a route to an internet gateway
          const { stdout: routeTableOutput } = await execAsync(`aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=${subnet.SubnetId}" --profile ${profile} --region ${region}`);
          const routeTables = JSON.parse(routeTableOutput);
          
          let hasInternetGatewayRoute = false;
          
          for (const routeTable of routeTables.RouteTables) {
            for (const route of routeTable.Routes) {
              if (route.GatewayId && route.GatewayId.startsWith('igw-')) {
                hasInternetGatewayRoute = true;
                break;
              }
            }
            if (hasInternetGatewayRoute) break;
          }
          
          // If no internet gateway route, it's likely a private subnet
          if (!hasInternetGatewayRoute) {
            privateSubnetsWithAZ.push({
              subnetId: subnet.SubnetId,
              az: subnet.AvailabilityZone
            });
          }
        } catch (error) {
          // If we can't determine, skip this subnet
          console.log(`⚠️  Could not determine subnet type for ${subnet.SubnetId}`);
        }
      }
      
      // Extract unique AZs and subnet IDs
      const subnetIds = privateSubnetsWithAZ.map(s => s.subnetId);
      const availabilityZones = [...new Set(privateSubnetsWithAZ.map(s => s.az))].sort();
      
      return { subnetIds, availabilityZones };
    } catch (error) {
      console.log("⚠️  Could not detect private subnets.");
      return { subnetIds: [], availabilityZones: [] };
    }
  }

  private async getProfileRegion(profile: string): Promise<string> {
    try {
      // Try to get region from AWS CLI config
      const { stdout } = await execAsync(`aws configure get region --profile ${profile}`);
      const region = stdout.trim();
      return region || 'us-west-2'; // fallback to us-west-2
    } catch (error) {
      // If that fails, try to get default region
      try {
        const { stdout } = await execAsync(`aws configure get region`);
        return stdout.trim() || 'us-west-2';
      } catch (error2) {
        return process.env.AWS_DEFAULT_REGION || 'us-west-2';
      }
    }
  }

  private async isBootstrapped(profile: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${profile}`);
      const identity = JSON.parse(stdout);
      const account = identity.Account;
      const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';
      
      // Check if bootstrap stack exists
      const { stdout: stacks } = await execAsync(`aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --profile ${profile} --region ${region}`);
      const stackList = JSON.parse(stacks);
      
      return stackList.StackSummaries.some((stack: any) => 
        stack.StackName.startsWith('CDKToolkit')
      );
    } catch (error) {
      return false;
    }
  }

  private async bootstrapCdk(profile: string): Promise<void> {
    console.log(`🔧 Bootstrapping CDK for profile: ${profile}...`);
    
    // Temporarily rename cdk.json to avoid conflicts
    const cdkJsonExists = await fs.access('cdk.json').then(() => true).catch(() => false);
    if (cdkJsonExists) {
      await fs.rename('cdk.json', 'cdk.json.tmp');
    }

    try {
      const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${profile}`);
      const identity = JSON.parse(stdout);
      const account = identity.Account;
      const region = process.env.AWS_DEFAULT_REGION || 'us-west-2';

      console.log(`📍 Account: ${account}`);
      console.log(`🌎 Region: ${region}`);

      // Run bootstrap command
      await new Promise<void>((resolve, reject) => {
        const bootstrap = spawn('npx', ['--package', 'aws-cdk', 'cdk', 'bootstrap', 
          `aws://${account}/${region}`, '--profile', profile], {
          stdio: 'inherit',
          shell: true,
        });

        bootstrap.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Bootstrap completed successfully!');
            resolve();
          } else {
            reject(new Error(`Bootstrap failed with exit code ${code}`));
          }
        });

        bootstrap.on('error', (error) => {
          reject(error);
        });
      });

    } finally {
      // Restore cdk.json
      if (cdkJsonExists) {
        await fs.rename('cdk.json.tmp', 'cdk.json');
      }
    }
  }

  private async deployStack(config: DeploymentConfig) {
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
      } else {
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
      const stackName = `${config.appName}-stack`;

      // CDK needs explicit account/region for VPC lookup
      console.log(`🔍 Detecting private subnets in VPC ${config.vpcId}...`);
      const { subnetIds: privateSubnetIds, availabilityZones } = await this.getPrivateSubnets(config.vpcId, config.awsProfile);
      
      if (privateSubnetIds.length === 0) {
        throw new Error(`No private subnets found in VPC ${config.vpcId}. Make sure your VPC has private subnets with routes to NAT gateways or NAT instances.`);
      }
      
      console.log(`✅ Found ${privateSubnetIds.length} private subnets: ${privateSubnetIds.join(', ')}`);
      console.log(`📍 Availability zones: ${availabilityZones.join(', ')}`);
      console.log(`🔧 Environment variables set: CDK_DEFAULT_ACCOUNT=${process.env.CDK_DEFAULT_ACCOUNT}, CDK_DEFAULT_REGION=${process.env.CDK_DEFAULT_REGION}`);
      
      // Add private subnet info to config
      const configWithSubnets = { 
        ...config, 
        detectedPrivateSubnets: privateSubnetIds,
        detectedAvailabilityZones: availabilityZones
      };
      
      new AppDeploymentStack(app, stackName, configWithSubnets, {
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
      console.log(
        "🐳 Docker image: docker.io/joshcutts/error-analysis-app:latest"
      );

      // Deploy using CDK CLI with selected AWS profile
      const assemblyDir = cloudAssembly.directory;
      return new Promise<void>(async (resolve, reject) => {
        const profileFlag = ["--profile", config.awsProfile];
        
        console.log(`Running: npx --package aws-cdk cdk deploy ${stackName} --require-approval never --app ${assemblyDir} --profile ${config.awsProfile}`);
        
        // Temporarily rename cdk.json to avoid conflicts during deployment
        const cdkJsonExists = await fs.access('cdk.json').then(() => true).catch(() => false);
        if (cdkJsonExists) {
          await fs.rename('cdk.json', 'cdk.json.tmp');
        }

        try {
          // Use npx with --package flag to ensure we get the real AWS CDK
          // Point to the synthesized CloudFormation templates
          const cdkDeploy = spawn("npx", ["--package", "aws-cdk", "cdk", "deploy", stackName, "--require-approval", "never", "--app", assemblyDir, ...profileFlag], {
            stdio: "inherit",
            shell: true,
          });

          cdkDeploy.on("close", async (code) => {
            // Restore cdk.json
            if (cdkJsonExists) {
              await fs.rename('cdk.json.tmp', 'cdk.json');
            }

            if (code === 0) {
              console.log("\n✅ Deployment completed successfully!");
              console.log(
                "\n💡 Monitor your application in AWS CloudFormation console"
              );
              console.log(
                "🔗 Connect to VPN and access your app via the private IP shown in outputs"
              );
              console.log("🏥 Use /health endpoint to verify the app is running");
              resolve();
            } else {
              console.log(`\n❌ CDK deployment process exited with code ${code}`);
              reject(new Error(`CDK deployment failed with exit code ${code}`));
            }
          });

          cdkDeploy.on("error", async (error) => {
            // Restore cdk.json on error
            if (cdkJsonExists) {
              await fs.rename('cdk.json.tmp', 'cdk.json');
            }
            console.log(`\n❌ Error launching CDK deployment: ${error.message}`);
            reject(error);
          });

        } catch (fileError) {
          // Restore cdk.json on any file operation error
          if (cdkJsonExists) {
            await fs.rename('cdk.json.tmp', 'cdk.json').catch(() => {});
          }
          reject(fileError);
        }
      });
    } catch (synthError) {
      console.log(`\n❌ Error during CDK synthesis: ${synthError instanceof Error ? synthError.message : synthError}`);
      throw synthError;
    }
  }

  public run() {
    this.program.parse();
  }
}

// Run CLI if executed directly
if (require.main === module) {
  const cli = new DeploymentCLI();
  cli.run();
}
