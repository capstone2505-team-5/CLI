#!/usr/bin/env node
// test-main-deployment-scenario.ts

import { execSync } from 'child_process';

async function testMainDeploymentScenario() {
  try {
    console.log("🧪 Testing the exact main deployment scenario...\n");
    
    // Simulate the main deployment flow
    console.log("📥 Importing deployLambdaEdge function...");
    const { deployLambdaEdge } = await import('./deploy-lambda-edge');
    console.log("✅ Successfully imported deployLambdaEdge function");
    console.log("🔍 deployLambdaEdge function type:", typeof deployLambdaEdge);
    
    // Get real outputs from CloudFormation (like the main deployment does)
    const stackName = 'alex-auth-test11-stack';
    const profile = 'capstone-profile';
    const region = 'us-west-2';
    
    console.log("🔍 Getting CloudFormation outputs...");
    const command = `aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`;
    const output = execSync(command, { encoding: 'utf8' });
    const outputs = JSON.parse(output);
    
    // Extract required values (like the main deployment does)
    const findOutput = (key: string) => {
      const output = outputs.find((o: any) => o.OutputKey === key);
      if (!output) {
        console.log(`❌ Output key '${key}' not found in CloudFormation outputs`);
        console.log("📋 Available output keys:");
        outputs.forEach((o: any) => console.log(`   - ${o.OutputKey}`));
      }
      return output?.OutputValue;
    };
    
    const userPoolClientId = findOutput('UserPoolClientId');
    const userPoolDomain = findOutput('UserPoolDomain');
    const cloudFrontDomain = findOutput('CloudFrontDomain');
    const appName = findOutput('AppName');
    
    console.log("🔍 Extracted values from CloudFormation outputs:");
    console.log(`   User Pool Client ID: ${userPoolClientId ? '✅ Found' : '❌ Missing'}`);
    console.log(`   User Pool Domain: ${userPoolDomain ? '✅ Found' : '❌ Missing'}`);
    console.log(`   CloudFront Domain: ${cloudFrontDomain ? '✅ Found' : '❌ Missing'}`);
    console.log(`   App Name: ${appName ? '✅ Found' : '❌ Missing'}`);
    
    if (!userPoolClientId || !userPoolDomain || !cloudFrontDomain || !appName) {
      console.log("❌ Missing required CloudFormation outputs");
      return;
    }
    
    // Create configuration (like the main deployment does)
    const lambdaEdgeConfig = {
      appName,
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
    
    console.log("✅ Main deployment scenario test completed successfully!");
    
  } catch (error) {
    console.log(`❌ Test failed: ${error instanceof Error ? error.message : error}`);
  }
}

testMainDeploymentScenario(); 