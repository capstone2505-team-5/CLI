#!/usr/bin/env node
// deploy-lambda-edge.ts

import * as cdk from "aws-cdk-lib";
import { LambdaEdgeStack } from "./lambda-edge-stack";
import * as fs from "fs";
import * as path from "path";

interface LambdaEdgeDeploymentConfig {
  appName: string;
  userPoolClientId: string;
  userPoolDomain: string;
  cloudFrontDomain: string;
}

function getLambdaEdgeConfig(): LambdaEdgeDeploymentConfig {
  // Try to read configuration from global variable
  const globalConfig = (global as any).lambdaEdgeConfig;
  
  if (!globalConfig) {
    throw new Error("❌ Lambda@Edge configuration not found in global variable. Please run the main deployment first: npm run dev");
  }
  
  console.log("🔍 Reading Lambda@Edge configuration from global variable:");
  console.log(`   App Name: ${globalConfig.appName}`);
  console.log(`   User Pool Client ID: ${globalConfig.userPoolClientId}`);
  console.log(`   User Pool Domain: ${globalConfig.userPoolDomain}`);
  console.log(`   CloudFront Domain: ${globalConfig.cloudFrontDomain}`);
  
  return globalConfig;
}

async function deployLambdaEdge(mainConfig?: any) {
  try {
    console.log("🚀 Deploying Lambda@Edge functions to us-east-1...");

    let config: LambdaEdgeDeploymentConfig;
    
    if (mainConfig && mainConfig.appName && mainConfig.userPoolClientId && mainConfig.userPoolDomain && mainConfig.cloudFrontDomain) {
      console.log("🔍 Using configuration from main deployment:", mainConfig);
      config = mainConfig;
    } else {
      console.log("🔍 No valid main config provided, falling back to manual deployment");
      try {
        config = getLambdaEdgeConfig();
      } catch (error) {
        console.log("❌ No configuration available for Lambda@Edge deployment");
        console.log("💡 This usually means:");
        console.log("   1. The main deployment hasn't completed successfully");
        console.log("   2. CloudFormation outputs are not available yet");
        console.log("   3. You're trying to run this script manually without proper configuration");
        console.log("\n💡 Solutions:");
        console.log("   1. Wait a few minutes and try the main deployment again");
        console.log("   2. Run the debug tool: npm run debug-stack");
        console.log("   3. Deploy manually later: npm run deploy:lambda-edge");
        throw new Error("Lambda@Edge configuration not available. Please run the main deployment first.");
      }
    }

    console.log("📋 Configuration for Lambda@Edge deployment:");
    console.log(`   App Name: ${config.appName}`);
    console.log(`   User Pool Client ID: ${config.userPoolClientId}`);
    console.log(`   User Pool Domain: ${config.userPoolDomain}`);
    console.log(`   CloudFront Domain: ${config.cloudFrontDomain}`);
    
    // Validate configuration
    if (!config.appName || !config.userPoolClientId || !config.userPoolDomain || !config.cloudFrontDomain) {
      console.log("❌ Invalid configuration - missing required values:");
      console.log(`   App Name: ${config.appName ? '✅' : '❌'}`);
      console.log(`   User Pool Client ID: ${config.userPoolClientId ? '✅' : '❌'}`);
      console.log(`   User Pool Domain: ${config.userPoolDomain ? '✅' : '❌'}`);
      console.log(`   CloudFront Domain: ${config.cloudFrontDomain ? '✅' : '❌'}`);
      throw new Error("Invalid Lambda@Edge configuration - missing required values");
    }

    // Write the config.js file with actual resolved values
    writeConfigFile(config);

    const app = new cdk.App();

    new LambdaEdgeStack(app, `${config.appName}-lambda-edge-stack`, {
      userPoolClientId: config.userPoolClientId,
      userPoolDomain: config.userPoolDomain,
      cloudFrontDomain: config.cloudFrontDomain,
    });

    console.log("✅ Lambda@Edge stack created successfully!");
    console.log("🚀 Deploying Lambda@Edge stack to AWS...");
    
    // Deploy the stack using CDK
    const { execSync } = await import('child_process');
    const stackName = `${config.appName}-lambda-edge-stack`;
    
    try {
      console.log(`📦 Deploying stack: ${stackName}`);
      console.log(`👤 Using AWS profile: ${process.env.AWS_PROFILE || 'default'}`);
      console.log(`🌎 Deploying to region: us-east-1`);
      
      // Deploy the stack using the separate CDK app
      const deployEnv = {
        ...process.env,
        CDK_DEFAULT_REGION: 'us-east-1',
        AWS_DEFAULT_REGION: 'us-east-1',
        LAMBDA_EDGE_APP_NAME: config.appName,
        LAMBDA_EDGE_USER_POOL_CLIENT_ID: config.userPoolClientId,
        LAMBDA_EDGE_USER_POOL_DOMAIN: config.userPoolDomain,
        LAMBDA_EDGE_CLOUDFRONT_DOMAIN: config.cloudFrontDomain,
      };
      
      // Check if CDK is bootstrapped in us-east-1
      console.log("🔧 Checking if CDK is bootstrapped in us-east-1...");
      try {
        execSync(`aws sts get-caller-identity --profile ${process.env.AWS_PROFILE || 'default'} --region us-east-1`, { stdio: 'pipe' });
        const stdout = execSync(`aws cloudformation describe-stacks --stack-name CDKToolkit --profile ${process.env.AWS_PROFILE || 'default'} --region us-east-1 --query 'Stacks[0].StackStatus' --output text`, { stdio: 'pipe' });
        if (stdout.toString().trim() === 'CREATE_COMPLETE' || stdout.toString().trim() === 'UPDATE_COMPLETE') {
          console.log("✅ CDK already bootstrapped in us-east-1");
        } else {
          throw new Error("CDK not bootstrapped");
        }
      } catch (bootstrapError) {
        console.log("⚡ CDK not bootstrapped in us-east-1. Bootstrapping automatically...");
        execSync(`npx cdk bootstrap aws://${process.env.CDK_DEFAULT_ACCOUNT || '088044432001'}/us-east-1 --profile ${process.env.AWS_PROFILE || 'default'} --app "npx ts-node lambda-edge-app.ts"`, {
          stdio: 'inherit',
          env: deployEnv
        });
        console.log("✅ CDK bootstrap completed in us-east-1");
      }
      
      // Check if stack exists and destroy it if it's in a bad state
      console.log("🔍 Checking stack status...");
      try {
        const stackStatus = execSync(`aws cloudformation describe-stacks --stack-name ${stackName} --profile ${process.env.AWS_PROFILE || 'default'} --region us-east-1 --query 'Stacks[0].StackStatus' --output text`, { 
          stdio: 'pipe',
          env: deployEnv
        });
        const status = stackStatus.toString().trim();
        console.log(`📊 Stack status: ${status}`);
        
        if (status === 'UPDATE_ROLLBACK_FAILED' || status === 'UPDATE_FAILED' || status === 'CREATE_FAILED') {
          console.log("⚠️  Stack is in a failed state. Destroying and recreating...");
          execSync(`npx cdk destroy ${stackName} --force --profile ${process.env.AWS_PROFILE || 'default'} --app "npx ts-node lambda-edge-app.ts" --region us-east-1 --context appName=${config.appName} --context userPoolClientId=${config.userPoolClientId} --context userPoolDomain=${config.userPoolDomain} --context cloudFrontDomain=${config.cloudFrontDomain}`, {
            stdio: 'inherit',
            env: deployEnv
          });
          console.log("✅ Stack destroyed successfully");
        }
      } catch (error) {
        console.log("📊 Stack doesn't exist or can't be described. Proceeding with deployment...");
      }
      
      // Deploy the stack
      console.log("🚀 Deploying Lambda@Edge stack...");
      execSync(`npx cdk deploy ${stackName} --require-approval never --profile ${process.env.AWS_PROFILE || 'default'} --app "npx ts-node lambda-edge-app.ts" --region us-east-1 --context appName=${config.appName} --context userPoolClientId=${config.userPoolClientId} --context userPoolDomain=${config.userPoolDomain} --context cloudFrontDomain=${config.cloudFrontDomain}`, {
        stdio: 'inherit',
        env: deployEnv
      });
      
      console.log("✅ Lambda@Edge stack deployed successfully to AWS!");
      console.log("📋 Next steps:");
      console.log("1. Note the function ARNs from the outputs above");
      console.log("2. Update your CloudFront distribution with the Lambda@Edge functions");
      console.log("3. Test the authentication flow");
      
    } catch (deployError) {
      console.log("❌ Lambda@Edge deployment failed:");
      console.log(`   Error: ${deployError instanceof Error ? deployError.message : deployError}`);
      console.log("\n💡 Troubleshooting:");
      console.log("   • Check that your AWS profile has permissions for us-east-1");
      console.log("   • Verify that CDK is bootstrapped in us-east-1");
      console.log("   • Try deploying manually: npx cdk deploy --profile your-profile");
      throw deployError;
    }

  } catch (error) {
    console.error("❌ Failed to create Lambda@Edge stack:", error);
    process.exit(1);
  }
}

function writeConfigFile(config: LambdaEdgeDeploymentConfig) {
  const configPath = path.join(__dirname, "./pkce_edge/config.js");
  const redirectUri = `https://${config.cloudFrontDomain}/callback`;
  const logoutUri = `https://${config.cloudFrontDomain}`;
  
  const configContent = `// Configuration for Lambda@Edge functions
// This file is automatically updated during deployment
module.exports = {
    USER_POOL_CLIENT_ID: '${config.userPoolClientId}',
    USER_POOL_DOMAIN: '${config.userPoolDomain}',
    REDIRECT_URI: '${redirectUri}',
    LOGOUT_URI: '${logoutUri}',
    COOKIE_SETTINGS: {
        idToken: 'spa-id-token',
        accessToken: 'spa-access-token',
        refreshToken: 'spa-refresh-token',
        pkce: 'spa-pkce'
    }
};`;

  try {
    fs.writeFileSync(configPath, configContent);
    console.log(`✅ Updated config.js with actual values`);
  } catch (error) {
    console.error(`❌ Failed to update config.js:`, error);
    throw error;
  }
}

// Export the function for use in other modules
export { deployLambdaEdge };

// Only run if this file is executed directly (not imported)
if (require.main === module) {
  // When run directly, try to get config from global variable
  deployLambdaEdge().catch(error => {
    console.error("❌ Lambda@Edge deployment failed:", error);
    process.exit(1);
  });
} else {
  // When imported, just export the function without executing it
  console.log("📥 Lambda@Edge module imported successfully");
} 