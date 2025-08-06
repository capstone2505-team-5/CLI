#!/usr/bin/env node
// debug-cloudformation.ts

import { execSync } from 'child_process';
import inquirer from 'inquirer';

async function debugCloudFormation() {
  console.log("🔍 CloudFormation Stack Debug Tool\n");
  
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "stackName",
      message: "Enter CloudFormation stack name:",
      default: "error-analysis-app-stack",
    },
    {
      type: "input",
      name: "profile",
      message: "Enter AWS profile:",
      default: "default",
    },
    {
      type: "input",
      name: "region",
      message: "Enter AWS region:",
      default: "us-west-2",
    }
  ]);
  
  const { stackName, profile, region } = answers;
  
  console.log(`\n🔍 Debugging stack: ${stackName}`);
  console.log(`👤 Profile: ${profile}`);
  console.log(`🌎 Region: ${region}\n`);
  
  try {
    // Check if stack exists
    console.log("1. Checking if stack exists...");
    const stackStatus = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].StackStatus' --output text`, { 
      encoding: 'utf8',
      stdio: 'pipe'
    });
    console.log(`   ✅ Stack status: ${stackStatus.trim()}`);
    
    // Get all outputs
    console.log("\n2. Getting all outputs...");
    const outputsJson = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${profile} --region ${region} --query 'Stacks[0].Outputs' --output json`, { 
      encoding: 'utf8',
      stdio: 'pipe'
    });
    const outputs = JSON.parse(outputsJson);
    console.log(`   📊 Found ${outputs.length} outputs:`);
    
    outputs.forEach((output: any) => {
      console.log(`   - ${output.OutputKey}: ${output.OutputValue}`);
    });
    
    // Check for required outputs
    console.log("\n3. Checking for required outputs...");
    const requiredOutputs = ['UserPoolClientId', 'UserPoolDomain', 'CloudFrontDomain', 'CloudFrontDistributionId'];
    const missingOutputs = requiredOutputs.filter(key => !outputs.find((o: any) => o.OutputKey === key));
    
    if (missingOutputs.length === 0) {
      console.log("   ✅ All required outputs found!");
    } else {
      console.log("   ❌ Missing required outputs:");
      missingOutputs.forEach(key => console.log(`   - ${key}`));
    }
    
    // Get stack events (last 5)
    console.log("\n4. Recent stack events...");
    const eventsJson = execSync(`aws cloudformation describe-stack-events --stack-name ${stackName} --profile ${profile} --region ${region} --query 'StackEvents[0:5]' --output json`, { 
      encoding: 'utf8',
      stdio: 'pipe'
    });
    const events = JSON.parse(eventsJson);
    
    events.forEach((event: any) => {
      const timestamp = new Date(event.Timestamp).toLocaleString();
      console.log(`   ${timestamp} - ${event.LogicalResourceId}: ${event.ResourceStatus}`);
      if (event.ResourceStatusReason) {
        console.log(`     Reason: ${event.ResourceStatusReason}`);
      }
    });
    
  } catch (error) {
    console.log(`❌ Error: ${error instanceof Error ? error.message : error}`);
    console.log("\n💡 Troubleshooting tips:");
    console.log("• Verify the stack name is correct");
    console.log("• Check that the AWS profile has the necessary permissions");
    console.log("• Ensure the region is correct");
    console.log("• Check if the stack deployment completed successfully");
  }
}

// Run if executed directly
if (require.main === module) {
  debugCloudFormation().catch(console.error);
} 