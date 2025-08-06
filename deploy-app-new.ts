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
import { LambdaEdgeStack } from "./lambda-edge-stack";

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
  cognitoRedirectUris?: string[];
  allowSelfSignup: boolean;
  createAdminUser: boolean;
  adminEmail?: string;
  adminPassword?: string;
  
  // CloudFront Configuration
  cloudFrontDomain?: string;
  certificateArn?: string;
  
  // Lambda@Edge Configuration (set after deployment)
  userPoolClientId?: string;
  userPoolDomain?: string;
}

// Main deployment stack
export class AppDeploymentStack extends cdk.Stack {
  public lambdaEdgeConfig: any;
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
    const { userPool, userPoolClient } = this.createCognitoUserPool(config);

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
    const { s3Bucket, cloudFrontDistribution } = this.createFrontendInfrastructure(config, userPool, userPoolClient);

    // Create outputs
    this.createOutputs(
      config,
      database,
      lambdaFunctions,
      apiSecrets,
      userPool,
      userPoolClient,
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

  private createCognitoUserPool(config: DeploymentConfig): { userPool: cognito.UserPool; userPoolClient: cognito.UserPoolClient } {
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
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          ...(config.cognitoRedirectUris || []),
          "https://temp-callback-url.com/callback", // Temporary URL, will be replaced during post-deployment
          // Add CloudFront callback URL (will be updated after CloudFront is created)
        ],
        logoutUrls: [
          ...(config.cognitoRedirectUris || []),
          "https://temp-callback-url.com", // Temporary URL, will be replaced during post-deployment
          // Add CloudFront signout URL (will be updated after CloudFront is created)
        ],
      },
      // Enable identity providers
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
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

    return { userPool, userPoolClient };
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



  private createFrontendInfrastructure(
    config: DeploymentConfig,
    userPool: cognito.UserPool,
    userPoolClient: cognito.UserPoolClient,
    lambdaEdgeStack?: LambdaEdgeStack
  ) {
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

    // Create a single shared S3 origin to avoid multiple origins
    const s3Origin = new origins.S3Origin(s3Bucket);

    // Create CloudFront distribution with all behaviors configured
    const cloudFrontDistribution = new cloudfront.Distribution(this, "CloudFrontDistribution", {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
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
      additionalBehaviors: {
        "/signin": {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        "/signout": {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
        "/callback": {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
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
    userPoolClient: cognito.UserPoolClient,
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



    // Outputs for Lambda@Edge deployment
    new cdk.CfnOutput(this, "AppName", {
      value: config.appName,
      description: "Application Name",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID",
    });

    new cdk.CfnOutput(this, "UserPoolDomain", {
      value: `https://${config.cognitoDomain}.auth.${this.region}.amazoncognito.com`,
      description: "Cognito User Pool Domain",
    });

    new cdk.CfnOutput(this, "CloudFrontDomain", {
      value: cloudFrontDistribution.distributionDomainName,
      description: "CloudFront Distribution Domain",
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: cloudFrontDistribution.distributionId,
      description: "CloudFront Distribution ID",
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

    this.program
      .command("debug-stack")
      .description("Debug CloudFormation stack outputs")
      .option("-s, --stack-name <name>", "Stack name to debug")
      .option("-p, --profile <profile>", "AWS profile to use")
      .option("-r, --region <region>", "AWS region")
      .action(this.handleDebugStack.bind(this));
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
    console.log(`🌐 Cognito Redirect URIs: ${(config.cognitoRedirectUris || []).join(", ")}`);
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
      cognitoRedirectUris: [], // Default to empty array since we'll add CloudFront URLs automatically
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
      
      const stack = new AppDeploymentStack(app, stackName, config, {
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
              console.log("\n✅ Main deployment completed successfully!");
              
              // Deploy Lambda@Edge functions to us-east-1
              console.log("\n🚀 Starting Lambda@Edge deployment process...");
              console.log("   This will wait for CloudFront to be fully deployed and then deploy Lambda@Edge functions to us-east-1");
              console.log("   This process may take several minutes...");
              
              try {
                await this.deployLambdaEdgeStack(config, stackName);
                console.log("\n✅ Lambda@Edge deployment completed successfully!");
                console.log("   Your Lambda@Edge functions are now deployed and ready to use");
              } catch (lambdaEdgeError) {
                console.log(`\n⚠️  Lambda@Edge deployment failed: ${lambdaEdgeError}`);
                console.log("   You can deploy Lambda@Edge functions manually later using: npm run deploy:lambda-edge");
                console.log("   Or check the logs above for detailed error information");
              }
              
              console.log("\n💡 Next steps:");
              console.log("   1. Upload your frontend assets to the S3 bucket");
              console.log("   2. Access your app via the CloudFront URL");
              console.log("   3. Use Cognito hosted UI for authentication");
              console.log("   4. API Gateway provides backend endpoints");
              console.log("   5. Associate Lambda@Edge functions with CloudFront behaviors");
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

  private async debugCloudFormationStack(config: DeploymentConfig, stackName: string): Promise<void> {
    console.log("🔍 Debugging CloudFormation stack...");
    const { execSync } = await import('child_process');
    
    try {
      // Check if stack exists
      console.log("1. Checking if stack exists...");
      const stackExists = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region} --query 'Stacks[0].StackStatus' --output text`, { 
        encoding: 'utf8',
        stdio: 'pipe'
      });
      console.log(`   Stack status: ${stackExists.trim()}`);
      
      // Get all outputs
      console.log("2. Getting all outputs...");
      const allOutputs = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region} --query 'Stacks[0].Outputs' --output json`, { 
        encoding: 'utf8',
        stdio: 'pipe'
      });
      const outputs = JSON.parse(allOutputs);
      console.log(`   Found ${outputs.length} outputs:`);
      outputs.forEach((output: any) => {
        console.log(`   - ${output.OutputKey}: ${output.OutputValue}`);
      });
      
    } catch (error) {
      console.log(`❌ Debug failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async handleDebugStack(options: any) {
    console.log("🔍 Debugging CloudFormation stack...\n");
    
    const stackName = options.stackName || await inquirer.prompt([
      {
        type: "input",
        name: "stackName",
        message: "Enter stack name to debug:",
        default: "error-analysis-app-stack",
      }
    ]).then(answer => answer.stackName);
    
    const profile = options.profile || await inquirer.prompt([
      {
        type: "input",
        name: "profile",
        message: "Enter AWS profile:",
        default: "default",
      }
    ]).then(answer => answer.profile);
    
    const region = options.region || await inquirer.prompt([
      {
        type: "input",
        name: "region",
        message: "Enter AWS region:",
        default: "us-west-2",
      }
    ]).then(answer => answer.region);
    
    const config: DeploymentConfig = {
      appName: "debug",
      openApiKey: "",
      phoenixApiKey: "",
      phoenixApiUrl: "",
      awsProfile: profile,
      region: region,
      availabilityZones: [],
      cognitoDomain: "",
      cognitoRedirectUris: [],
      allowSelfSignup: false,
      createAdminUser: false,
    };
    
    try {
      await this.debugCloudFormationStack(config, stackName);
    } catch (error) {
      console.log(`❌ Debug failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  private async deployLambdaEdgeStack(config: DeploymentConfig, stackName: string): Promise<void> {
    try {
      console.log("🚀 Starting Lambda@Edge deployment process...");
      console.log(`📋 Stack Name: ${stackName}`);
      console.log(`👤 AWS Profile: ${config.awsProfile}`);
      console.log(`🌎 AWS Region: ${config.region}`);
      
      // Import the Lambda@Edge deployment function
      console.log("📥 Importing deployLambdaEdge function...");
      const { deployLambdaEdge } = await import('./deploy-lambda-edge');
      console.log("✅ Successfully imported deployLambdaEdge function");
      console.log("🔍 deployLambdaEdge function type:", typeof deployLambdaEdge);
      
      // Get CloudFormation outputs from the deployed stack with retry logic
      const { execSync } = await import('child_process');
      
      console.log("🔍 Querying CloudFormation outputs from deployed stack...");
      console.log(`   Command: aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region} --query 'Stacks[0].Outputs' --output json`);
      
      // Add retry logic with exponential backoff
      let outputs: any[] = [];
      let retryCount = 0;
      const maxRetries = 5;
      const baseDelay = 2000; // 2 seconds
      
      while (retryCount < maxRetries) {
        try {
          console.log(`🔄 Attempt ${retryCount + 1}/${maxRetries} to get CloudFormation outputs...`);
          
          const outputsJson = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region} --query 'Stacks[0].Outputs' --output json`, { 
            encoding: 'utf8',
            stdio: 'pipe'
          });
          
          outputs = JSON.parse(outputsJson);
          console.log("✅ Successfully retrieved CloudFormation outputs");
          break;
          
        } catch (error) {
          retryCount++;
          console.log(`❌ Attempt ${retryCount} failed: ${error instanceof Error ? error.message : error}`);
          
          if (retryCount < maxRetries) {
            const delay = baseDelay * Math.pow(2, retryCount - 1); // Exponential backoff
            console.log(`⏳ Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            console.log("❌ Failed to get CloudFormation outputs after all retries");
            console.log("💡 Troubleshooting tips:");
            console.log(`   • Verify the stack name: ${stackName}`);
            console.log(`   • Check AWS profile: ${config.awsProfile}`);
            console.log(`   • Verify region: ${config.region}`);
            console.log(`   • Run manually: aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region}`);
            
            // Run debug function to get more information
            console.log("\n🔍 Running debug diagnostics...");
            await this.debugCloudFormationStack(config, stackName);
            
            throw new Error(`Failed to get CloudFormation outputs after ${maxRetries} attempts`);
          }
        }
      }
      
      console.log(`📊 Found ${outputs.length} CloudFormation outputs:`);
      outputs.forEach((output: any) => {
        console.log(`   - ${output.OutputKey}: ${output.OutputValue}`);
      });
      
      // Extract required values from outputs with better error handling
      const findOutput = (key: string) => {
        const output = outputs.find((o: any) => o.OutputKey === key);
        if (!output) {
          console.log(`❌ Output key '${key}' not found in CloudFormation outputs`);
          console.log("📋 Available output keys:");
          outputs.forEach((o: any) => console.log(`   - ${o.OutputKey}`));
        }
        return output?.OutputValue;
      };
      
      const userPoolId = findOutput('CognitoUserPoolId');
      const userPoolClientId = findOutput('UserPoolClientId');
      const userPoolDomain = findOutput('UserPoolDomain');
      const cloudFrontDomain = findOutput('CloudFrontDomain');
      const distributionId = findOutput('CloudFrontDistributionId');
      
      console.log("🔍 Extracted values from CloudFormation outputs:");
      console.log(`   User Pool Client ID: ${userPoolClientId ? '✅ Found' : '❌ Missing'}`);
      console.log(`   User Pool Domain: ${userPoolDomain ? '✅ Found' : '❌ Missing'}`);
      console.log(`   CloudFront Domain: ${cloudFrontDomain ? '✅ Found' : '❌ Missing'}`);
      console.log(`   CloudFront Distribution ID: ${distributionId ? '✅ Found' : '❌ Missing'}`);
      
      // Wait for CloudFront distribution to be fully deployed
      if (cloudFrontDomain && distributionId) {
        console.log("⏳ Waiting for CloudFront distribution to be fully deployed...");
        console.log(`   Distribution ID: ${distributionId}`);
        console.log(`   Domain: ${cloudFrontDomain}`);
        console.log(`   Command: aws cloudfront wait distribution-deployed --id ${distributionId} --profile ${config.awsProfile} --region ${config.region}`);
        
        try {
          // Wait for CloudFront to be deployed using AWS CLI
          execSync(`aws cloudfront wait distribution-deployed --id ${distributionId} --profile ${config.awsProfile} --region ${config.region}`, { 
            encoding: 'utf8',
            stdio: 'pipe'
          });
          console.log("✅ CloudFront distribution is fully deployed and ready");
        } catch (waitError) {
          console.log("⚠️  CloudFront wait failed, but continuing with deployment:");
          console.log(`   Error: ${waitError}`);
          console.log("   This might be because the distribution is already deployed or there's a temporary issue");
          console.log("   Continuing with Lambda@Edge deployment...");
        }
      } else {
        console.log("⚠️  Cannot wait for CloudFront - missing required outputs");
        if (!cloudFrontDomain) console.log("   - CloudFrontDomain output not found");
        if (!distributionId) console.log("   - CloudFrontDistributionId output not found");
        console.log("   Continuing with Lambda@Edge deployment anyway...");
      }
      
      console.log("🔧 Creating Lambda@Edge configuration with actual deployed values:");
      console.log(`   App Name: ${config.appName}`);
      console.log(`   User Pool Client ID: ${userPoolClientId}`);
      console.log(`   User Pool Domain: ${userPoolDomain}`);
      console.log(`   CloudFront Domain: ${cloudFrontDomain}`);
      
      if (!userPoolClientId || !userPoolDomain || !cloudFrontDomain) {
        console.log("❌ Missing required CloudFormation outputs:");
        console.log(`   User Pool Client ID: ${userPoolClientId ? '✅' : '❌'}`);
        console.log(`   User Pool Domain: ${userPoolDomain ? '✅' : '❌'}`);
        console.log(`   CloudFront Domain: ${cloudFrontDomain ? '✅' : '❌'}`);
        console.log("📋 Available outputs:");
        outputs.forEach((output: any) => {
          console.log(`   - ${output.OutputKey}`);
        });
        
        console.log("\n💡 Troubleshooting options:");
        console.log("1. Wait a few minutes and try again (CloudFormation outputs may take time to propagate)");
        console.log("2. Check the CloudFormation console to verify the stack deployment status");
        console.log("3. Run manually: aws cloudformation describe-stacks --stack-name ${stackName} --profile ${config.awsProfile} --region ${config.region}");
        console.log("4. Deploy Lambda@Edge manually later using: npm run deploy:lambda-edge");
        
        throw new Error(`Required CloudFormation outputs not found. Please check the main deployment completed successfully.`);
      }
      
      // Set environment variables for us-east-1 deployment
      console.log("🌍 Setting AWS region to us-east-1 for Lambda@Edge deployment...");
      process.env.CDK_DEFAULT_REGION = 'us-east-1';
      process.env.AWS_DEFAULT_REGION = 'us-east-1';
      console.log("✅ Environment variables set for us-east-1");
      
      // Deploy Lambda@Edge stack with actual deployed values
      console.log("🚀 Calling deployLambdaEdge with resolved values...");
      const lambdaEdgeConfig = {
        appName: config.appName,
        userPoolClientId,
        userPoolDomain,
        cloudFrontDomain,
      };
      
      console.log("📋 Lambda@Edge configuration being passed:");
      console.log(`   App Name: ${lambdaEdgeConfig.appName}`);
      console.log(`   User Pool Client ID: ${lambdaEdgeConfig.userPoolClientId}`);
      console.log(`   User Pool Domain: ${lambdaEdgeConfig.userPoolDomain}`);
      console.log(`   CloudFront Domain: ${lambdaEdgeConfig.cloudFrontDomain}`);
      
      console.log("🔍 About to call deployLambdaEdge function...");
      try {
        await deployLambdaEdge(lambdaEdgeConfig);
        console.log("✅ deployLambdaEdge function completed successfully");
      } catch (lambdaEdgeError) {
        console.log("❌ deployLambdaEdge function failed:");
        console.log(`   Error: ${lambdaEdgeError instanceof Error ? lambdaEdgeError.message : lambdaEdgeError}`);
        throw lambdaEdgeError;
      }
      
      console.log("✅ Lambda@Edge deployment completed successfully!");
      
      // Get Lambda@Edge outputs for post-deployment updates
      console.log("\n🔍 Getting Lambda@Edge stack outputs...");
      const lambdaEdgeStackName = `${config.appName}-lambda-edge-stack`;
      const lambdaEdgeOutputsCommand = `aws cloudformation describe-stacks --stack-name ${lambdaEdgeStackName} --profile ${config.awsProfile} --region us-east-1 --query 'Stacks[0].Outputs' --output json`;
      const lambdaEdgeOutputsJson = execSync(lambdaEdgeOutputsCommand, { encoding: 'utf8' });
      const lambdaEdgeOutputs = JSON.parse(lambdaEdgeOutputsJson);
      
      console.log("✅ Retrieved Lambda@Edge stack outputs");
      
      // Post-deployment updates
      console.log("\n🔧 Starting post-deployment updates...");
      await this.performPostDeploymentUpdates(config, stackName, {
        userPoolId,
        userPoolClientId,
        userPoolDomain,
        cloudFrontDomain,
        distributionId,
        lambdaEdgeOutputs
      });
      
    } catch (error) {
      console.log("❌ Lambda@Edge deployment failed with error:");
      console.log(`   ${error}`);
      console.log("🔍 Debug information:");
      console.log(`   Stack Name: ${stackName}`);
      console.log(`   AWS Profile: ${config.awsProfile}`);
      console.log(`   AWS Region: ${config.region}`);
      throw new Error(`Lambda@Edge deployment failed: ${error}`);
    }
  }

  private async performPostDeploymentUpdates(
    config: DeploymentConfig, 
    stackName: string, 
    outputs: {
      userPoolId: string;
      userPoolClientId: string;
      userPoolDomain: string;
      cloudFrontDomain: string;
      distributionId: string;
      lambdaEdgeOutputs: any[];
    }
  ): Promise<void> {
    try {
      console.log("🔧 Performing post-deployment updates...");
      
      // 1. Update Cognito URLs
      console.log("\n📋 Step 1: Updating Cognito URLs...");
      await this.updateCognitoUrls(config, outputs);
      
      // 2. Update CloudFront with Lambda@Edge functions
      console.log("\n📋 Step 2: Updating CloudFront with Lambda@Edge functions...");
      await this.updateCloudFrontWithLambdaEdge(config, outputs);
      
      // 3. Update CloudFront origin policies
      console.log("\n📋 Step 3: Updating CloudFront origin policies...");
      await this.updateCloudFrontOriginPolicies(config, outputs.distributionId);
      
      console.log("✅ All post-deployment updates completed successfully!");
      
    } catch (error) {
      console.log("❌ Post-deployment updates failed:");
      console.log(`   ${error}`);
      console.log("💡 You can run these updates manually later if needed");
      console.log("⚠️  WARNING: Your Cognito client may not be properly configured for OAuth flows!");
      console.log("   You may need to manually update the Cognito client configuration.");
    }
  }

  private async updateCognitoUrls(
    config: DeploymentConfig,
    outputs: {
      userPoolId: string;
      userPoolClientId: string;
      userPoolDomain: string;
      cloudFrontDomain: string;
      distributionId: string;
      lambdaEdgeOutputs: any[];
    }
  ): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      
      console.log("🔍 Getting current user pool client configuration...");
      const getClientCommand = `aws cognito-idp describe-user-pool-client --user-pool-id ${outputs.userPoolId} --client-id ${outputs.userPoolClientId} --profile ${config.awsProfile} --region ${config.region} --output json`;
      const clientOutput = execSync(getClientCommand, { encoding: 'utf8' });
      const clientConfig = JSON.parse(clientOutput);

      // Construct the URLs
      const callbackUrl = `https://${outputs.cloudFrontDomain}/callback`;
      const signoutUrl = `https://${outputs.cloudFrontDomain}`;

      // Update the callback URLs and logout URLs
      const currentCallbackUrls = clientConfig.UserPoolClient.CallbackURLs || [];
      const currentLogoutUrls = clientConfig.UserPoolClient.LogoutURLs || [];

      // Add the new URLs if they don't already exist
      const updatedCallbackUrls = [...new Set([...currentCallbackUrls, callbackUrl])];
      const updatedLogoutUrls = [...new Set([...currentLogoutUrls, signoutUrl])];

      // Update the user pool client
      console.log("🚀 Updating Cognito User Pool Client...");
      const updateCommand = `aws cognito-idp update-user-pool-client \
        --user-pool-id ${outputs.userPoolId} \
        --client-id ${outputs.userPoolClientId} \
        --callback-urls ${updatedCallbackUrls.join(' ')} \
        --logout-urls ${updatedLogoutUrls.join(' ')} \
        --supported-identity-providers COGNITO \
        --allowed-o-auth-flows code \
        --allowed-o-auth-scopes email openid profile \
        --allowed-o-auth-flows-user-pool-client \
        --profile ${config.awsProfile} \
        --region ${config.region}`;

      execSync(updateCommand, { stdio: 'inherit' });
      console.log("✅ Cognito URLs and configuration updated successfully!");

    } catch (error) {
      console.log(`❌ Error updating Cognito URLs: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private async updateCloudFrontWithLambdaEdge(
    config: DeploymentConfig,
    outputs: {
      userPoolId: string;
      userPoolClientId: string;
      userPoolDomain: string;
      cloudFrontDomain: string;
      distributionId: string;
      lambdaEdgeOutputs: any[];
    }
  ): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      
      // Get Lambda@Edge function ARNs
      const viewerRequestArn = outputs.lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'ViewerRequestFunctionArn')?.OutputValue;
      const signinArn = outputs.lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'SigninFunctionArn')?.OutputValue;
      const signoutArn = outputs.lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'SignoutFunctionArn')?.OutputValue;
      const callbackArn = outputs.lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'CallbackFunctionArn')?.OutputValue;

      if (!viewerRequestArn || !signinArn || !signoutArn || !callbackArn) {
        throw new Error("Missing required Lambda@Edge function ARNs");
      }

      // Get current CloudFront distribution configuration
      console.log("🔍 Getting current CloudFront distribution configuration...");
      const getConfigCommand = `aws cloudfront get-distribution-config --id ${outputs.distributionId} --profile ${config.awsProfile} --region ${config.region} --output json`;
      const configOutput = execSync(getConfigCommand, { encoding: 'utf8' });
      const cloudFrontConfig = JSON.parse(configOutput);

      const distributionConfig = cloudFrontConfig.DistributionConfig;
      const etag = cloudFrontConfig.ETag;

      // Update cache behaviors with Lambda@Edge functions
      console.log("🔧 Updating cache behaviors with Lambda@Edge functions...");

      // Update default cache behavior (viewer request for all paths)
      if (distributionConfig.DefaultCacheBehavior) {
        distributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations = {
          Quantity: 1,
          Items: [
            {
              LambdaFunctionARN: viewerRequestArn,
              EventType: 'viewer-request',
              IncludeBody: false
            }
          ]
        };
      }

      // Update specific cache behaviors
      if (distributionConfig.CacheBehaviors && distributionConfig.CacheBehaviors.Items) {
        const updatedBehaviors = distributionConfig.CacheBehaviors.Items.map((behavior: any) => {
          if (behavior.PathPattern === '/signin') {
            return {
              ...behavior,
              LambdaFunctionAssociations: {
                Quantity: 1,
                Items: [
                  {
                    LambdaFunctionARN: signinArn,
                    EventType: 'viewer-request',
                    IncludeBody: false
                  }
                ]
              }
            };
          } else if (behavior.PathPattern === '/signout') {
            return {
              ...behavior,
              LambdaFunctionAssociations: {
                Quantity: 1,
                Items: [
                  {
                    LambdaFunctionARN: signoutArn,
                    EventType: 'viewer-request',
                    IncludeBody: false
                  }
                ]
              }
            };
          } else if (behavior.PathPattern === '/callback') {
            return {
              ...behavior,
              LambdaFunctionAssociations: {
                Quantity: 1,
                Items: [
                  {
                    LambdaFunctionARN: callbackArn,
                    EventType: 'viewer-request',
                    IncludeBody: false
                  }
                ]
              }
            };
          }
          return behavior;
        });

        distributionConfig.CacheBehaviors.Items = updatedBehaviors;
      }

      // Write updated configuration to temporary file
      const tempConfigFile = 'cloudfront-lambda-edge-temp.json';
      require('fs').writeFileSync(tempConfigFile, JSON.stringify(distributionConfig, null, 2));

      // Update CloudFront distribution
      console.log("🚀 Updating CloudFront distribution with Lambda@Edge functions...");
      const updateCommand = `aws cloudfront update-distribution --id ${outputs.distributionId} --distribution-config file://${tempConfigFile} --if-match "${etag}" --profile ${config.awsProfile} --region ${config.region}`;

      execSync(updateCommand, { stdio: 'inherit' });

      // Clean up temporary file
      require('fs').unlinkSync(tempConfigFile);
      console.log("✅ CloudFront updated with Lambda@Edge functions successfully!");

    } catch (error) {
      console.log(`❌ Error updating CloudFront with Lambda@Edge: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  private async updateCloudFrontOriginPolicies(
    config: DeploymentConfig,
    distributionId: string
  ): Promise<void> {
    try {
      const { execSync } = await import('child_process');
      
      // Get current CloudFront distribution configuration
      console.log("🔍 Getting current CloudFront distribution configuration...");
      const getConfigCommand = `aws cloudfront get-distribution-config --id ${distributionId} --profile ${config.awsProfile} --region ${config.region} --output json`;
      const configOutput = execSync(getConfigCommand, { encoding: 'utf8' });
      const cloudFrontConfig = JSON.parse(configOutput);

      const distributionConfig = cloudFrontConfig.DistributionConfig;
      const etag = cloudFrontConfig.ETag;

      // Remove origin request policies from cache behaviors
      console.log("🔧 Removing origin request policies from cache behaviors...");

      // Update specific cache behaviors
      if (distributionConfig.CacheBehaviors && distributionConfig.CacheBehaviors.Items) {
        const updatedBehaviors = distributionConfig.CacheBehaviors.Items.map((behavior: any) => {
          if (behavior.PathPattern === '/signin' || 
              behavior.PathPattern === '/signout' || 
              behavior.PathPattern === '/callback') {
            
            console.log(`   Removing origin request policy from ${behavior.PathPattern} behavior`);
            
            // Remove the origin request policy
            const updatedBehavior = { ...behavior };
            delete updatedBehavior.OriginRequestPolicyId;
            
            return updatedBehavior;
          }
          return behavior;
        });

        distributionConfig.CacheBehaviors.Items = updatedBehaviors;
      }

      // Write updated configuration to temporary file
      const tempConfigFile = 'cloudfront-origin-policy-temp.json';
      require('fs').writeFileSync(tempConfigFile, JSON.stringify(distributionConfig, null, 2));

      // Update CloudFront distribution
      console.log("🚀 Updating CloudFront distribution to remove origin request policies...");
      const updateCommand = `aws cloudfront update-distribution --id ${distributionId} --distribution-config file://${tempConfigFile} --if-match "${etag}" --profile ${config.awsProfile} --region ${config.region}`;

      execSync(updateCommand, { stdio: 'inherit' });

      // Clean up temporary file
      require('fs').unlinkSync(tempConfigFile);
      console.log("✅ CloudFront origin policies updated successfully!");

    } catch (error) {
      console.log(`❌ Error updating CloudFront origin policies: ${error instanceof Error ? error.message : error}`);
      throw error;
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