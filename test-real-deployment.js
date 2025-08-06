#!/usr/bin/env node
// test-real-deployment.js

const { execSync } = require('child_process');

async function testRealDeployment() {
  try {
    console.log("🧪 Testing Lambda@Edge deployment with real CloudFormation outputs...\n");
    
    // Get outputs from CloudFormation
    const stackName = 'alex-auth-test11-stack';
    const profile = 'capstone-profile';
    const region = 'us-west-2';
    
    const command = `aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`;
    const output = execSync(command, { encoding: 'utf8' });
    const outputs = JSON.parse(output);
    
    // Extract required values
    const userPoolClientId = outputs.find(o => o.OutputKey === 'UserPoolClientId')?.OutputValue;
    const userPoolDomain = outputs.find(o => o.OutputKey === 'UserPoolDomain')?.OutputValue;
    const cloudFrontDomain = outputs.find(o => o.OutputKey === 'CloudFrontDomain')?.OutputValue;
    const appName = outputs.find(o => o.OutputKey === 'AppName')?.OutputValue;
    
    console.log("📋 Real configuration from CloudFormation:");
    console.log(`   App Name: ${appName}`);
    console.log(`   User Pool Client ID: ${userPoolClientId}`);
    console.log(`   User Pool Domain: ${userPoolDomain}`);
    console.log(`   CloudFront Domain: ${cloudFrontDomain}`);
    
    if (!userPoolClientId || !userPoolDomain || !cloudFrontDomain || !appName) {
      console.log("❌ Missing required values from CloudFormation outputs");
      return;
    }
    
    // Import and test the Lambda@Edge deployment
    const { deployLambdaEdge } = await import('./deploy-lambda-edge.ts');
    
    console.log("\n🚀 Testing Lambda@Edge deployment with real values...");
    await deployLambdaEdge({
      appName,
      userPoolClientId,
      userPoolDomain,
      cloudFrontDomain,
    });
    
    console.log("✅ Real deployment test completed successfully!");
    
  } catch (error) {
    console.log(`❌ Test failed: ${error.message}`);
  }
}

testRealDeployment(); 