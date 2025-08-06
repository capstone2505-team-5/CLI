#!/usr/bin/env node
// update-cloudfront-origin-policy.ts

import { execSync } from 'child_process';

async function updateCloudFrontOriginPolicy() {
  try {
    console.log("🔧 Updating CloudFront distribution to remove origin request policies...\n");

    // Get configuration from CloudFormation outputs
    const stackName = 'alex-auth-test13-stack';
    const profile = 'capstone-profile';
    const region = 'us-west-2';

    console.log("🔍 Getting CloudFormation outputs...");
    const command = `aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`;
    const output = execSync(command, { encoding: 'utf8' });
    const outputs = JSON.parse(output);

    // Extract distribution ID
    const findOutput = (key: string) => {
      const output = outputs.find((o: any) => o.OutputKey === key);
      if (!output) {
        console.log(`❌ Output key '${key}' not found in CloudFormation outputs`);
        return null;
      }
      return output?.OutputValue;
    };

    const distributionId = findOutput('CloudFrontDistributionId');

    if (!distributionId) {
      console.log("❌ CloudFront Distribution ID not found");
      return;
    }

    console.log(`🔍 Distribution ID: ${distributionId}`);

    // Get current CloudFront distribution configuration
    console.log("\n🔍 Getting current CloudFront distribution configuration...");
    const getConfigCommand = `aws cloudfront get-distribution-config --id ${distributionId} --profile ${profile} --region ${region} --output json`;
    const configOutput = execSync(getConfigCommand, { encoding: 'utf8' });
    const config = JSON.parse(configOutput);

    const distributionConfig = config.DistributionConfig;
    const etag = config.ETag;

    console.log("✅ Retrieved CloudFront distribution configuration");

    // Remove origin request policies from cache behaviors
    console.log("\n🔧 Removing origin request policies from cache behaviors...");

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
      console.log("✅ Updated cache behaviors to remove origin request policies");
    }

    // Write updated configuration to temporary file
    const tempConfigFile = 'cloudfront-origin-policy-temp.json';
    require('fs').writeFileSync(tempConfigFile, JSON.stringify(distributionConfig, null, 2));
    console.log(`📝 Wrote updated configuration to ${tempConfigFile}`);

    // Update CloudFront distribution
    console.log("\n🚀 Updating CloudFront distribution...");
    const updateCommand = `aws cloudfront update-distribution --id ${distributionId} --distribution-config file://${tempConfigFile} --if-match "${etag}" --profile ${profile} --region ${region}`;

    console.log(`Running: ${updateCommand}`);
    execSync(updateCommand, { stdio: 'inherit' });

    console.log("✅ CloudFront distribution updated successfully!");
    console.log("\n📋 Origin request policies removed from:");
    console.log("   • /signin behavior");
    console.log("   • /signout behavior");
    console.log("   • /callback behavior");

    // Clean up temporary file
    require('fs').unlinkSync(tempConfigFile);
    console.log("🧹 Cleaned up temporary configuration file");

    console.log("\n⏳ Note: CloudFront distribution updates may take 5-10 minutes to deploy");
    console.log("   You can monitor the deployment status in the AWS CloudFront console");

  } catch (error) {
    console.log(`❌ Error updating CloudFront: ${error instanceof Error ? error.message : error}`);
  }
}

updateCloudFrontOriginPolicy(); 