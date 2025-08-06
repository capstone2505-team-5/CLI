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

    // Create Lambda@Edge functions
    const viewerRequestFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuthViewerRequest", {
      entry: path.join(__dirname, "./pkce_edge/cloudfront-auth-viewer-request/index.js"),
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

    const signinFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuthSignin", {
      entry: path.join(__dirname, "./pkce_edge/cloudfront-auth-signin/index.js"),
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

    const signoutFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuthSignout", {
      entry: path.join(__dirname, "./pkce_edge/cloudfront-auth-signout/index.js"),
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

    const callbackFunction = new lambdaNodejs.NodejsFunction(this, "CloudFrontAuthCallback", {
      entry: path.join(__dirname, "./pkce_edge/cloudfront-auth-callback/index.js"),
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

    // Publish versions of the Lambda functions for Lambda@Edge
    const viewerRequestVersion = new lambda.Version(this, "CloudFrontAuthViewerRequestVersion", {
      lambda: viewerRequestFunction,
      description: "Version 1 of Viewer Request Lambda@Edge function",
    });

    const signinVersion = new lambda.Version(this, "CloudFrontAuthSigninVersion", {
      lambda: signinFunction,
      description: "Version 1 of Signin Lambda@Edge function",
    });

    const signoutVersion = new lambda.Version(this, "CloudFrontAuthSignoutVersion", {
      lambda: signoutFunction,
      description: "Version 1 of Signout Lambda@Edge function",
    });

    const callbackVersion = new lambda.Version(this, "CloudFrontAuthCallbackVersion", {
      lambda: callbackFunction,
      description: "Version 1 of Callback Lambda@Edge function",
    });

    // Output the function version ARNs for use with CloudFront
    // Use stack-specific export names to avoid conflicts
    const stackName = this.stackName;
    
    new cdk.CfnOutput(this, "ViewerRequestFunctionArn", {
      value: viewerRequestVersion.functionArn,
      description: "Lambda@Edge Viewer Request Function Version ARN",
      exportName: `${stackName}-ViewerRequestFunctionArn`,
    });

    new cdk.CfnOutput(this, "SigninFunctionArn", {
      value: signinVersion.functionArn,
      description: "Lambda@Edge Signin Function Version ARN",
      exportName: `${stackName}-SigninFunctionArn`,
    });

    new cdk.CfnOutput(this, "SignoutFunctionArn", {
      value: signoutVersion.functionArn,
      description: "Lambda@Edge Signout Function Version ARN",
      exportName: `${stackName}-SignoutFunctionArn`,
    });

    new cdk.CfnOutput(this, "CallbackFunctionArn", {
      value: callbackVersion.functionArn,
      description: "Lambda@Edge Callback Function Version ARN",
      exportName: `${stackName}-CallbackFunctionArn`,
    });
  }
} 