#!/usr/bin/env node
// lambda-edge-stack.ts

import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as fs from "fs";
import * as path from "path";
import { Construct } from "constructs";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as s3 from "aws-cdk-lib/aws-s3";

interface LambdaEdgeConfig {
  userPoolClientId: string;
  userPoolDomain: string;
  cloudFrontDomain: string;
}

export class LambdaEdgeStack extends cdk.Stack {
  private config: LambdaEdgeConfig;
  public readonly apiRequestVersion: lambda.Version;
  public readonly authVersion: lambda.Version; // Expose the auth function version

  constructor(scope: Construct, id: string, config: LambdaEdgeConfig, props?: cdk.StackProps) {
    super(scope, id, {
      ...props,
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: "us-east-1", // Lambda@Edge must be in us-east-1
      },
    });

    // Store config for later use during deployment
    this.config = config;

    // Create IAM role for Lambda@Edge functions
    const lambdaEdgeRole = new iam.Role(this, "LambdaEdgeRole", {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("lambda.amazonaws.com"),
        new iam.ServicePrincipal("edgelambda.amazonaws.com")
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    // Create single Lambda@Edge authentication function (implicit flow)
    const authFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuth", {
      entry: path.join(__dirname, "./edge/index.js"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(5), // Lambda@Edge has 5-second timeout
      role: lambdaEdgeRole,
      bundling: {
        minify: false, // Don't minify for debugging
        sourceMap: false, // Disable source maps for Lambda@Edge
        externalModules: [], // Don't externalize any modules
        nodeModules: [], // Don't exclude node_modules
        target: "es2020", // Use ES2020 target
      },
    });

    const apiRequestFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuthApiRequest", {
      entry: path.join(__dirname, "./pkce_edge/cloudfront-auth-api-request/index.js"),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(5),
      role: lambdaEdgeRole,
      bundling: {
        minify: false, // Don't minify for debugging
        sourceMap: false,
        externalModules: [],
        nodeModules: [],
        target: "es2020",
      },
    });

    // Publish version of the Lambda function for Lambda@Edge
    this.authVersion = new lambda.Version(this, "CloudFrontAuthVersion", {
      lambda: authFunction,
      description: "Version 1 of Authentication Lambda@Edge function",
    });

    const apiRequestVersion = new lambda.Version(this, "CloudFrontAuthApiRequestVersion", {
      lambda: apiRequestFunction,
      description: "Version 1 of API Request Lambda@Edge function",
    });

    // Output the function version ARN for use with CloudFront
    // Use stack-specific export names to avoid conflicts
    const stackName = this.stackName;
    
    new cdk.CfnOutput(this, "AuthFunctionArn", {
      value: this.authVersion.functionArn,
      description: "Lambda@Edge Authentication Function Version ARN",
      exportName: `${stackName}-AuthFunctionArn`,
    });

    new cdk.CfnOutput(this, "ApiRequestFunctionArn", {
      value: apiRequestVersion.functionArn,
      description: "Lambda@Edge API Request Function Version ARN",
      exportName: `${stackName}-ApiRequestFunctionArn`,
    });

    // Expose the version as a public property for use in other stacks
    this.apiRequestVersion = apiRequestVersion;
  }
} 