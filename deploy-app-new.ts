#!/usr/bin/env node
// deploy-app-new.ts

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
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import inquirer from "inquirer";
import { Command } from "commander";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from 'path';

const execAsync = promisify(exec);

// Configuration interface
interface DeploymentConfig {
  appName: string;
  openApiKey: string;
  phoenixApiKey: string;
  phoenixApiUrl: string;
  
  // AWS Profile
  awsProfile: string;
  
  // AWS Region and Availability Zones
  region: string;
  availabilityZones: string[];
  
  // Cognito Configuration
  cognitoDomain: string;
  cognitoRedirectUris: string[];
  allowSelfSignup: boolean;
  createAdminUser: boolean;
  adminEmail?: string;
  adminPassword?: string;
  
  // CloudFront Configuration
  cloudFrontDomain?: string;
  certificateArn?: string;
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

    // Create VPC with networking infrastructure
    const vpc = this.createVpc();

    // Create security groups
    const { lambdaSecurityGroup, dbSecurityGroup } = this.createSecurityGroups(vpc);

    // Create RDS database
    const database = this.createDatabase(vpc, dbSecurityGroup, config);

    // Create API secrets
    const apiSecrets = this.createApiSecrets(config);

    // Create Cognito User Pool
    const userPool = this.createCognitoUserPool(config);

    // Create Lambda functions
    const lambdaFunctions = this.createLambdaFunctions(
      vpc,
      database,
      apiSecrets,
      lambdaSecurityGroup,
      config
    );

    // Create API Gateway
    const apiGateway = this.createApiGateway(lambdaFunctions, userPool);

    // Create EventBridge Scheduler
    this.createEventBridgeScheduler(lambdaFunctions.getAllProjectsLambda, config);

    // Create S3 bucket and CloudFront distribution
    const { s3Bucket, cloudFrontDistribution } = this.createFrontendInfrastructure(config);

    // Create outputs
    this.createOutputs(
      config,
      database,
      lambdaFunctions,
      apiSecrets,
      userPool,
      apiGateway,
      s3Bucket,
      cloudFrontDistribution
    );
  }

  private createVpc(): ec2.Vpc {
    // Use the availability zones selected by the user
    const availabilityZones = this.node.tryGetContext('availabilityZones') || ['us-west-2a', 'us-west-2b'];
    
    console.log(`🔧 Creating VPC with AZs: ${availabilityZones.join(', ')}`);
    
    return new ec2.Vpc(this, "AppVpc", {
      natGateways: 1, // Single NAT Gateway for cost optimization
      availabilityZones: availabilityZones,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "PrivateLambda",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: "PrivateRDS",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
  }

  private createSecurityGroups(vpc: ec2.Vpc) {
    // Lambda security group
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc,
      description: "Security group for Lambda functions",
      allowAllOutbound: true,
    });

    // Database security group
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "Security group for RDS database",
      allowAllOutbound: false,
    });

    // Allow Lambda to access RDS
    dbSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      "PostgreSQL from Lambda functions"
    );

    return { lambdaSecurityGroup, dbSecurityGroup };
  }

  private createDatabase(
    vpc: ec2.Vpc,
    securityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ): rds.DatabaseInstance {
    return new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15_8,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      credentials: rds.Credentials.fromGeneratedSecret("appuser", {
        secretName: `${config.appName}-db-credentials`,
      }),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [securityGroup],
      databaseName: "error_analysis",
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      multiAz: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      deleteAutomatedBackups: false,
    });
  }

  private createApiSecrets(config: DeploymentConfig): secretsmanager.Secret {
    return new secretsmanager.Secret(this, "ApiKeysSecret", {
      secretName: `${config.appName}-api-keys`,
      description: "API keys for Error Analysis application",
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        openaiApiKey: config.openApiKey,
        phoenixApiKey: config.phoenixApiKey,
      })),
    });
  }

  private createCognitoUserPool(config: DeploymentConfig): cognito.UserPool {
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${config.appName}-user-pool`,
      selfSignUpEnabled: config.allowSelfSignup,
      signInAliases: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add domain for hosted UI
    userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix: config.cognitoDomain,
      },
    });

    // Create user pool client
    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: `${config.appName}-client`,
      generateSecret: false,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID],
        callbackUrls: config.cognitoRedirectUris,
        logoutUrls: config.cognitoRedirectUris,
      },
    });

    // Create admin user if requested
    if (config.createAdminUser && config.adminEmail && config.adminPassword) {
      new cr.AwsCustomResource(this, "AdminUser", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminCreateUser",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Username: config.adminEmail,
            UserAttributes: [
              {
                Name: "email",
                Value: config.adminEmail,
              },
              {
                Name: "email_verified",
                Value: "true",
              },
            ],
            MessageAction: "SUPPRESS",
          },
          physicalResourceId: cr.PhysicalResourceId.of("AdminUser"),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["cognito-idp:AdminCreateUser"],
            resources: [userPool.userPoolArn],
          }),
        ]),
      });

      // Set admin password
      new cr.AwsCustomResource(this, "AdminPassword", {
        onCreate: {
          service: "CognitoIdentityServiceProvider",
          action: "adminSetUserPassword",
          parameters: {
            UserPoolId: userPool.userPoolId,
            Username: config.adminEmail,
            Password: config.adminPassword,
            Permanent: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of("AdminPassword"),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ["cognito-idp:AdminSetUserPassword"],
            resources: [userPool.userPoolArn],
          }),
        ]),
      });
    }

    return userPool;
  }

  private createLambdaFunctions(
    vpc: ec2.Vpc,
    database: rds.DatabaseInstance,
    apiSecrets: secretsmanager.Secret,
    securityGroup: ec2.SecurityGroup,
    config: DeploymentConfig
  ) {
    // Create separate IAM roles for each Lambda function
    const dbCreationRole = new iam.Role(this, "DbCreationLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    const getAllProjectRootSpansRole = new iam.Role(this, "GetAllProjectRootSpansLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    const getAllProjectsRole = new iam.Role(this, "GetAllProjectsLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    // Grant access to API secrets for all roles
    apiSecrets.grantRead(dbCreationRole);
    apiSecrets.grantRead(getAllProjectRootSpansRole);
    apiSecrets.grantRead(getAllProjectsRole);

    // Database creation Lambda
    const dbCreationLambda = new lambdaNodejs.NodejsFunction(this, "DbCreationLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/dbCreation/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [securityGroup],
      role: dbCreationRole,
      environment: {
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || `${config.appName}-db-credentials`,
        NODE_ENV: "production",
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Get all project root spans Lambda
    const getAllProjectRootSpansLambda = new lambdaNodejs.NodejsFunction(this, "GetAllProjectRootSpansLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/ingestProject/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [securityGroup],
      role: getAllProjectRootSpansRole,
      environment: {
        NODE_ENV: "production",
        PHOENIX_API_URL: config.phoenixApiUrl,
        PHOENIX_API_KEY_SECRET_NAME: apiSecrets.secretName,
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || `${config.appName}-db-credentials`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Get all projects Lambda
    const getAllProjectsLambda = new lambdaNodejs.NodejsFunction(this, "GetAllProjectsLambda", {
      entry: path.join(__dirname, "./lambdas/src/lambdas/entry/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(5),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [securityGroup],
      role: getAllProjectsRole,
      environment: {
        NODE_ENV: "production",
        PHOENIX_API_URL: config.phoenixApiUrl,
        PHOENIX_API_KEY_SECRET_NAME: apiSecrets.secretName,
        SPAN_INGESTION_ARN: getAllProjectRootSpansLambda.functionArn,
        RDS_CREDENTIALS_SECRET_NAME: database.secret?.secretName || `${config.appName}-db-credentials`,
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Grant specific permission for GetAllProjectsLambda to invoke GetAllProjectRootSpansLambda
    getAllProjectRootSpansLambda.grantInvoke(getAllProjectsRole);

    // Allow Lambda to access RDS
    database.connections.allowFrom(
      securityGroup,
      ec2.Port.tcp(5432),
      "Allow Lambda to access RDS"
    );

    // Trigger database creation (simplified to avoid circular dependencies)
    this.triggerDbCreationLambda(dbCreationLambda, database);

    return {
      dbCreationLambda,
      getAllProjectRootSpansLambda,
      getAllProjectsLambda,
    };
  }

  private createApiGateway(
    lambdaFunctions: any,
    userPool: cognito.UserPool
  ): apigateway.RestApi {
    // Create Cognito Authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", {
      cognitoUserPools: [userPool],
    });

    // Create mock Lambda function
    const mockLambda = new lambdaNodejs.NodejsFunction(this, "MockApiLambda", {
      entry: path.join(__dirname, "./lambdas/src/mock-api/index.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        NODE_ENV: "production",
      },
      bundling: {
        minify: true,
        sourceMap: true,
      },
    });

    // Create API Gateway
    const api = new apigateway.RestApi(this, "ErrorAnalysisApi", {
      restApiName: "Error Analysis API",
      description: "API for Error Analysis application",
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });

    // Add mock endpoint with Cognito authorization
    const mockResource = api.root.addResource("mock");
    const mockIntegration = new apigateway.LambdaIntegration(mockLambda);
    
    mockResource.addMethod("GET", mockIntegration, {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    return api;
  }

  private createEventBridgeScheduler(
    lambdaFunction: lambda.Function,
    config: DeploymentConfig
  ) {
    // Create EventBridge rule for scheduled Lambda execution
    const rule = new events.Rule(this, "ScheduledDataUpdatesRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: "Scheduled data updates every 5 minutes",
    });

    rule.addTarget(new targets.LambdaFunction(lambdaFunction));
  }

  private triggerDbCreationLambda(
    lambdaFunction: lambda.Function,
    database: rds.DatabaseInstance
  ) {
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
  }

  private createFrontendInfrastructure(config: DeploymentConfig) {
    // Create S3 bucket for static assets with deployment
    const s3Bucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `${config.appName}-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Deploy frontend assets to S3 bucket
    const frontendDeployment = new s3deploy.BucketDeployment(this, "FrontendDeployment", {
      sources: [s3deploy.Source.asset("./frontend")],
      destinationBucket: s3Bucket,
      destinationKeyPrefix: "", // Upload to root of bucket
    });

    // Create CloudFront distribution
    const cloudFrontDistribution = new cloudfront.Distribution(this, "CloudFrontDistribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(s3Bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
      enableLogging: false, // Disable logging to avoid ACL issues
    });

    // Ensure CloudFront waits for deployment
    cloudFrontDistribution.node.addDependency(frontendDeployment);

    return { s3Bucket, cloudFrontDistribution };
  }



  private createOutputs(
    config: DeploymentConfig,
    database: rds.DatabaseInstance,
    lambdaFunctions: any,
    apiSecrets: secretsmanager.Secret,
    userPool: cognito.UserPool,
    apiGateway: apigateway.RestApi,
    s3Bucket: s3.Bucket,
    cloudFrontDistribution: cloudfront.Distribution
  ) {
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: database.instanceEndpoint.hostname,
      description: "Database Endpoint",
    });

    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: database.secret?.secretArn || "N/A",
      description: "Database Secret ARN",
    });

    new cdk.CfnOutput(this, "ApiGatewayUrl", {
      value: apiGateway.url,
      description: "API Gateway URL",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolArn", {
      value: userPool.userPoolArn,
      description: "Cognito User Pool ARN",
    });

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: `https://${config.cognitoDomain}.auth.${this.region}.amazoncognito.com`,
      description: "Cognito Hosted UI Domain",
    });

    new cdk.CfnOutput(this, "S3BucketName", {
      value: s3Bucket.bucketName,
      description: "S3 Bucket for Frontend Assets",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: cloudFrontDistribution.distributionId,
      description: "CloudFront Distribution ID",
    });

    new cdk.CfnOutput(this, "CloudFrontDomainName", {
      value: cloudFrontDistribution.distributionDomainName,
      description: "CloudFront Domain Name",
    });

    new cdk.CfnOutput(this, "ApiSecretsArn", {
      value: apiSecrets.secretArn,
      description: "API Keys Secret ARN",
    });

    // Lambda function outputs
    if (lambdaFunctions.dbCreationLambda) {
      new cdk.CfnOutput(this, "RDSTableCreation", {
        value: lambdaFunctions.dbCreationLambda.functionName,
        description: "Creates RDS tables",
      });
    }

    if (lambdaFunctions.getAllProjectRootSpansLambda) {
      new cdk.CfnOutput(this, "GetAllProjectRootSpans", {
        value: lambdaFunctions.getAllProjectRootSpansLambda.functionName,
        description: "Gets all project root spans",
      });
    }

    if (lambdaFunctions.getAllProjectsLambda) {
      new cdk.CfnOutput(this, "GetAllProjects", {
        value: lambdaFunctions.getAllProjectsLambda.functionName,
        description: "Gets all projects",
      });
    }

    new cdk.CfnOutput(this, "AccessInstructions", {
      value: [
        "1. Upload your frontend assets to the S3 bucket",
        "2. Access your app via CloudFront URL",
        "3. Use Cognito hosted UI for authentication",
        "4. API Gateway provides backend endpoints",
      ].join(" | "),
      description: "How to access your application",
    });
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
      .name("deploy-app-new")
      .description("Deploy error analysis application to AWS with modern architecture")
      .version("2.0.0");

    this.program
      .command("deploy")
      .description("Deploy application infrastructure")
      .option("-i, --interactive", "Interactive configuration")
      .action(this.handleDeploy.bind(this));
  }

  private async handleDeploy(options: any) {
    console.log("🚀 Starting Error Analysis App deployment (New Architecture)...\n");

    const config = await this.getInteractiveConfig();

    console.log("\n📋 Deployment Summary:");
    console.log(`👤 AWS Profile: ${config.awsProfile}`);
    console.log(`🌎 AWS Region: ${config.region}`);
    console.log(`📍 Availability Zones: ${config.availabilityZones.join(", ")}`);
    console.log(`📱 App Name: ${config.appName}`);
    console.log(`🔐 Cognito Domain: ${config.cognitoDomain}`);
    console.log(`🌐 Cognito Redirect URIs: ${config.cognitoRedirectUris.join(", ")}`);
    console.log(`👥 Self Signup: ${config.allowSelfSignup ? "Enabled" : "Disabled"}`);
    console.log(`👑 Create Admin User: ${config.createAdminUser ? "Yes" : "No"}`);
    console.log(`🔑 API Keys: OpenAI ✓, Phoenix ✓`);
    console.log(`⚡ Lambda: Database Creation, Project Management (Node.js 22.x)`);
    console.log(`🌍 Frontend: S3 + CloudFront Distribution`);
    console.log(`🔌 API: API Gateway with Cognito Authorization`);

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
        console.log(`   • Verify the selected profile (${config.awsProfile}) has the necessary permissions`);
        console.log(`   • Check that the Cognito domain prefix is unique`);
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

    // Get region and availability zones
    const region = await this.getProfileRegion(profileAnswer.awsProfile);
    const availableZones = await this.getAvailableAvailabilityZones(profileAnswer.awsProfile, region);
    
    console.log(`\n🌎 Detected region: ${region}`);
    console.log(`📍 Available availability zones: ${availableZones.join(', ')}`);

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
        type: "list",
        name: "region",
        message: "AWS Region:",
        choices: [
          { name: `${region} (detected)`, value: region },
          { name: "us-west-2", value: "us-west-2" },
          { name: "us-east-1", value: "us-east-1" },
          { name: "us-east-2", value: "us-east-2" },
          { name: "us-west-1", value: "us-west-1" },
        ],
        default: region,
      },
      {
        type: "list",
        name: "availabilityZone1",
        message: "Select first availability zone:",
        choices: availableZones.map(zone => ({ name: zone, value: zone })),
        default: availableZones[0],
      },
      {
        type: "list",
        name: "availabilityZone2",
        message: "Select second availability zone:",
        choices: availableZones.map(zone => ({ name: zone, value: zone })),
        default: availableZones[1],
      },
      {
        type: "input",
        name: "cognitoDomain",
        message: "Cognito domain prefix (unique, lowercase, no hyphens):",
        validate: (input: string) =>
          /^[a-z0-9]+$/.test(input) ||
          "Use lowercase letters and numbers only, no hyphens",
        default: "erroranalysis",
      },
      {
        type: "input",
        name: "cognitoRedirectUris",
        message: "Cognito redirect URIs (comma-separated):",
        filter: (input: string) => input.split(",").map((s: string) => s.trim()),
        validate: (input: string[]) =>
          input.length >= 1 || "At least one redirect URI required",
        default: "http://localhost:3000/callback,https://localhost:3000/callback",
      },
      {
        type: "confirm",
        name: "allowSelfSignup",
        message: "Allow self signup for Cognito?",
        default: true,
      },
      {
        type: "confirm",
        name: "createAdminUser",
        message: "Create an admin user during deployment?",
        default: false,
      },
      {
        type: "input",
        name: "adminEmail",
        message: "Admin user email:",
        when: (answers: any) => answers.createAdminUser,
        validate: (input: string) =>
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) || "Enter a valid email address",
      },
      {
        type: "password",
        name: "adminPassword",
        message: "Admin user password (min 8 chars, with uppercase, lowercase, number, symbol):",
        when: (answers: any) => answers.createAdminUser,
        validate: (input: string) =>
          /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(input) ||
          "Password must be at least 8 characters with uppercase, lowercase, number, and symbol",
      },
      {
        type: "password",
        name: "openApiKey",
        message: "OpenAI API Key:",
        mask: "*",
        validate: (input: string) => input.length > 0 || "OpenAI API Key is required",
        default: process.env.OPENAI_API_KEY || "",
      },
      {
        type: "password",
        name: "phoenixApiKey",
        message: "Phoenix API Key:",
        mask: "*",
        validate: (input: string) => input.length > 0 || "Phoenix API Key is required",
        default: process.env.PHOENIX_API_KEY || "",
      },
      {
        type: "input",
        name: "phoenixApiUrl",
        message: "Phoenix API URL:",
        validate: (input: string) =>
          input.startsWith("http") || "Please enter a valid URL",
        default: process.env.PHOENIX_API_URL || "",
      },
    ]);

    // Combine all answers
    const allAnswers = { ...profileAnswer, ...restOfAnswers };
    
    // Combine the two availability zone selections
    const availabilityZones = [allAnswers.availabilityZone1, allAnswers.availabilityZone2];
    
    return {
      ...allAnswers,
      availabilityZones,
      cognitoRedirectUris:
        typeof allAnswers.cognitoRedirectUris === "string"
          ? [allAnswers.cognitoRedirectUris]
          : allAnswers.cognitoRedirectUris,
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

  private async getAvailableAvailabilityZones(profile: string, region: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`aws ec2 describe-availability-zones --profile ${profile} --region ${region} --query 'AvailabilityZones[?State==\`available\`].ZoneName' --output text`);
      const zones = stdout.trim().split(/\s+/).filter(zone => zone.length > 0);
      return zones;
    } catch (error) {
      console.log("⚠️  Could not detect availability zones, using defaults");
      // Return default zones based on region
      if (region === 'us-west-2') {
        return ['us-west-2a', 'us-west-2b'];
      } else if (region === 'us-east-1') {
        return ['us-east-1a', 'us-east-1b'];
      } else if (region === 'us-east-2') {
        return ['us-east-2a', 'us-east-2b'];
      } else if (region === 'us-west-1') {
        return ['us-west-1a', 'us-west-1b'];
      } else {
        return [`${region}a`, `${region}b`];
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

      // Get account and use the selected region
      const { stdout } = await execAsync(`aws sts get-caller-identity --profile ${config.awsProfile}`);
      const identity = JSON.parse(stdout);
      const account = identity.Account;
      const region = config.region;

      // Validate region
      const validRegions = ['us-west-2', 'us-east-1', 'us-east-2', 'us-west-1'];
      if (!validRegions.includes(region)) {
        console.log(`⚠️  Warning: Region ${region} may not be supported. Using us-west-2 as fallback.`);
        config.region = 'us-west-2';
      }

      console.log(`📍 Account: ${account}`);
      console.log(`🌎 Region: ${region}`);

      // Set environment variables that CDK needs for context
      process.env.CDK_DEFAULT_ACCOUNT = account;
      process.env.CDK_DEFAULT_REGION = region;
      process.env.AWS_DEFAULT_REGION = region;

      const app = new cdk.App({
        context: {
          '@aws-cdk/core:newStyleStackSynthesis': true,
          'availabilityZones': config.availabilityZones,
        },
      });
      const stackName = `${config.appName}-stack`;

      console.log(`🔧 Environment variables set: CDK_DEFAULT_ACCOUNT=${process.env.CDK_DEFAULT_ACCOUNT}, CDK_DEFAULT_REGION=${process.env.CDK_DEFAULT_REGION}`);
      console.log(`🔧 Stack environment: account=${account}, region=${region}`);
      
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

      // Deploy using CDK CLI with selected AWS profile
      const assemblyDir = cloudAssembly.directory;
      return new Promise<void>(async (resolve, reject) => {
        const profileFlag = ["--profile", config.awsProfile];
        
        // Set environment variables for the deployment process
        const deployEnv = {
          ...process.env,
          AWS_PROFILE: config.awsProfile,
          CDK_DEFAULT_ACCOUNT: account,
          CDK_DEFAULT_REGION: region,
        };
        
        console.log(`🔧 Deployment environment: AWS_PROFILE=${deployEnv.AWS_PROFILE}, CDK_DEFAULT_ACCOUNT=${deployEnv.CDK_DEFAULT_ACCOUNT}, CDK_DEFAULT_REGION=${deployEnv.CDK_DEFAULT_REGION}`);
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
            env: deployEnv,
          });

          cdkDeploy.on("close", async (code) => {
            // Restore cdk.json
            if (cdkJsonExists) {
              await fs.rename('cdk.json.tmp', 'cdk.json');
            }

            if (code === 0) {
              console.log("\n✅ Deployment completed successfully!");
              console.log("\n💡 Next steps:");
              console.log("   1. Upload your frontend assets to the S3 bucket");
              console.log("   2. Access your app via the CloudFront URL");
              console.log("   3. Use Cognito hosted UI for authentication");
              console.log("   4. API Gateway provides backend endpoints");
              console.log("\n🔗 Monitor your application in AWS CloudFormation console");
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