#!/usr/bin/env node
// update-cloudfront-lambda-edge.ts

import { execSync } from 'child_process';

interface LambdaEdgeConfig {
  appName: string;
  userPoolClientId: string;
  userPoolDomain: string;
  cloudFrontDomain: string;
  distributionId: string;
}

async function updateCloudFrontWithLambdaEdge() {
  try {
    console.log("🚀 Updating CloudFront distribution with Lambda@Edge functions...\n");
    
    // Get configuration from CloudFormation outputs
    const stackName = 'alex-auth-test13-stack';
    const profile = 'capstone-profile';
    const region = 'us-west-2';
    
    console.log("🔍 Getting CloudFormation outputs...");
    const command = `aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`;
    const output = execSync(command, { encoding: 'utf8' });
    const outputs = JSON.parse(output);
    
    // Extract required values
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
    const distributionId = findOutput('CloudFrontDistributionId');
    
    console.log("🔍 Extracted values from CloudFormation outputs:");
    console.log(`   App Name: ${appName ? '✅ Found' : '❌ Missing'}`);
    console.log(`   User Pool Client ID: ${userPoolClientId ? '✅ Found' : '❌ Missing'}`);
    console.log(`   User Pool Domain: ${userPoolDomain ? '✅ Found' : '❌ Missing'}`);
    console.log(`   CloudFront Domain: ${cloudFrontDomain ? '✅ Found' : '❌ Missing'}`);
    console.log(`   Distribution ID: ${distributionId ? '✅ Found' : '❌ Missing'}`);
    
    if (!userPoolClientId || !userPoolDomain || !cloudFrontDomain || !appName || !distributionId) {
      console.log("❌ Missing required CloudFormation outputs");
      return;
    }
    
    // Get Lambda@Edge function ARNs from the Lambda@Edge stack
    console.log("\n🔍 Getting Lambda@Edge function ARNs...");
    const lambdaEdgeStackName = `${appName}-lambda-edge-stack`;
    const lambdaEdgeCommand = `aws cloudformation describe-stacks --stack-name ${lambdaEdgeStackName} --profile ${profile} --region us-east-1 --query 'Stacks[0].Outputs' --output json`;
    const lambdaEdgeOutput = execSync(lambdaEdgeCommand, { encoding: 'utf8' });
    const lambdaEdgeOutputs = JSON.parse(lambdaEdgeOutput);
    
    const viewerRequestArn = lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'ViewerRequestFunctionArn')?.OutputValue;
    const signinArn = lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'SigninFunctionArn')?.OutputValue;
    const signoutArn = lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'SignoutFunctionArn')?.OutputValue;
    const callbackArn = lambdaEdgeOutputs.find((o: any) => o.OutputKey === 'CallbackFunctionArn')?.OutputValue;
    
    console.log("🔍 Lambda@Edge function ARNs:");
    console.log(`   Viewer Request: ${viewerRequestArn ? '✅ Found' : '❌ Missing'}`);
    console.log(`   Signin: ${signinArn ? '✅ Found' : '❌ Missing'}`);
    console.log(`   Signout: ${signoutArn ? '✅ Found' : '❌ Missing'}`);
    console.log(`   Callback: ${callbackArn ? '✅ Found' : '❌ Missing'}`);
    
    if (!viewerRequestArn || !signinArn || !signoutArn || !callbackArn) {
      console.log("❌ Missing required Lambda@Edge function ARNs");
      return;
    }
    
    // Get current CloudFront distribution configuration
    console.log("\n🔍 Getting current CloudFront distribution configuration...");
    const getConfigCommand = `aws cloudfront get-distribution-config --id ${distributionId} --profile ${profile} --region ${region} --output json`;
    const configOutput = execSync(getConfigCommand, { encoding: 'utf8' });
    const config = JSON.parse(configOutput);
    
    const distributionConfig = config.DistributionConfig;
    const etag = config.ETag;
    
    console.log("✅ Retrieved CloudFront distribution configuration");
    
    // Update cache behaviors with Lambda@Edge functions
    console.log("\n🔧 Updating cache behaviors with Lambda@Edge functions...");
    
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
      console.log("✅ Updated default cache behavior with viewer request function");
    }
    
    // Update specific cache behaviors
    if (distributionConfig.CacheBehaviors && distributionConfig.CacheBehaviors.Items) {
      // Find and update /signin behavior
      const signinBehavior = distributionConfig.CacheBehaviors.Items.find((behavior: any) => 
        behavior.PathPattern === '/signin'
      );
      if (signinBehavior) {
        signinBehavior.LambdaFunctionAssociations = {
          Quantity: 1,
          Items: [
            {
              LambdaFunctionARN: signinArn,
              EventType: 'viewer-request',
              IncludeBody: false
            }
          ]
        };
        console.log("✅ Updated /signin behavior with signin function");
      }
      
      // Find and update /signout behavior
      const signoutBehavior = distributionConfig.CacheBehaviors.Items.find((behavior: any) => 
        behavior.PathPattern === '/signout'
      );
      if (signoutBehavior) {
        signoutBehavior.LambdaFunctionAssociations = {
          Quantity: 1,
          Items: [
            {
              LambdaFunctionARN: signoutArn,
              EventType: 'viewer-request',
              IncludeBody: false
            }
          ]
        };
        console.log("✅ Updated /signout behavior with signout function");
      }
      
      // Find and update /callback behavior
      const callbackBehavior = distributionConfig.CacheBehaviors.Items.find((behavior: any) => 
        behavior.PathPattern === '/callback'
      );
      if (callbackBehavior) {
        callbackBehavior.LambdaFunctionAssociations = {
          Quantity: 1,
          Items: [
            {
              LambdaFunctionARN: callbackArn,
              EventType: 'viewer-request',
              IncludeBody: false
            }
          ]
        };
        console.log("✅ Updated /callback behavior with callback function");
      }
    }
    
    // Write updated configuration to temporary file
    const tempConfigFile = 'cloudfront-config-temp.json';
    
    // The AWS CLI expects just the DistributionConfig, not wrapped in another object
    require('fs').writeFileSync(tempConfigFile, JSON.stringify(distributionConfig, null, 2));
    console.log(`📝 Wrote updated configuration to ${tempConfigFile}`);
    
    // Update CloudFront distribution
    console.log("\n🚀 Updating CloudFront distribution...");
    const updateCommand = `aws cloudfront update-distribution --id ${distributionId} --distribution-config file://${tempConfigFile} --if-match "${etag}" --profile ${profile} --region ${region}`;
    
    console.log(`Running: ${updateCommand}`);
    execSync(updateCommand, { stdio: 'inherit' });
    
    console.log("✅ CloudFront distribution updated successfully!");
    console.log("\n📋 Lambda@Edge functions associated:");
    console.log("   • Default behavior (*): Viewer Request function");
    console.log("   • /signin behavior: Signin function");
    console.log("   • /signout behavior: Signout function");
    console.log("   • /callback behavior: Callback function");
    
    // Clean up temporary file
    require('fs').unlinkSync(tempConfigFile);
    console.log("🧹 Cleaned up temporary configuration file");
    
    console.log("\n⏳ Note: CloudFront distribution updates may take 5-10 minutes to deploy");
    console.log("   You can monitor the deployment status in the AWS CloudFront console");
    
  } catch (error) {
    console.log(`❌ Error updating CloudFront: ${error instanceof Error ? error.message : error}`);
  }
}

updateCloudFrontWithLambdaEdge(); 