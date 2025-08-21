#!/usr/bin/env node
// lambda-edge-app.ts

import * as cdk from "aws-cdk-lib";
import { LambdaEdgeStack } from "./lambda-edge-stack";

// This is a separate CDK app for Lambda@Edge deployment
const app = new cdk.App();

// Get configuration from command line arguments or environment variables
// CDK passes these as context values when called from deploy-lambda-edge.ts
const appName = app.node.tryGetContext('appName') || process.env.LAMBDA_EDGE_APP_NAME || 'default-app';
const userPoolClientId = app.node.tryGetContext('userPoolClientId') || process.env.LAMBDA_EDGE_USER_POOL_CLIENT_ID || 'default-client-id';
const userPoolDomain = app.node.tryGetContext('userPoolDomain') || process.env.LAMBDA_EDGE_USER_POOL_DOMAIN || 'https://default.auth.us-west-2.amazoncognito.com';
const cloudFrontDomain = app.node.tryGetContext('cloudFrontDomain') || process.env.LAMBDA_EDGE_CLOUDFRONT_DOMAIN || 'default.cloudfront.net';

console.log('🔍 Lambda@Edge App Configuration:');
console.log(`   App Name: ${appName}`);
console.log(`   User Pool Client ID: ${userPoolClientId}`);
console.log(`   User Pool Domain: ${userPoolDomain}`);
console.log(`   CloudFront Domain: ${cloudFrontDomain}`);

// Create the Lambda@Edge stack
new LambdaEdgeStack(app, `${appName}-lambda-edge-stack`, {
  userPoolClientId,
  userPoolDomain,
  cloudFrontDomain,
});

// Export the app for CDK to use
export default app; 