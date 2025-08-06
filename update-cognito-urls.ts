#!/usr/bin/env node
// update-cognito-urls.ts

import { execSync } from 'child_process';

interface CognitoConfig {
  appName: string;
  userPoolId: string;
  userPoolClientId: string;
  cloudFrontDomain: string;
}

async function updateCognitoUrls() {
  try {
    console.log("🔧 Updating Cognito User Pool with CloudFront URLs...\n");

    // Get configuration from CloudFormation outputs
    const stackName = 'alex-auth-test21-stack'; // Updated to current stack
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

    const userPoolId = findOutput('CognitoUserPoolId');
    const userPoolClientId = findOutput('UserPoolClientId');
    const cloudFrontDomain = findOutput('CloudFrontDomain');
    const appName = findOutput('AppName');

    console.log("🔍 Extracted values from CloudFormation outputs:");
    console.log(`   App Name: ${appName ? '✅ Found' : '❌ Missing'}`);
    console.log(`   User Pool ID: ${userPoolId ? '✅ Found' : '❌ Missing'}`);
    console.log(`   User Pool Client ID: ${userPoolClientId ? '✅ Found' : '❌ Missing'}`);
    console.log(`   CloudFront Domain: ${cloudFrontDomain ? '✅ Found' : '❌ Missing'}`);

    if (!userPoolId || !userPoolClientId || !cloudFrontDomain || !appName) {
      console.log("❌ Missing required CloudFormation outputs");
      return;
    }

    // Construct the URLs
    const callbackUrl = `https://${cloudFrontDomain}/callback`;
    const signoutUrl = `https://${cloudFrontDomain}`;

    console.log("📋 URLs to add to Cognito:");
    console.log(`   Callback URL: ${callbackUrl}`);
    console.log(`   Signout URL: ${signoutUrl}`);

    // Get current user pool client configuration
    console.log("\n🔍 Getting current user pool client configuration...");
    const getClientCommand = `aws cognito-idp describe-user-pool-client --user-pool-id ${userPoolId} --client-id ${userPoolClientId} --profile ${profile} --region ${region} --output json`;
    const clientOutput = execSync(getClientCommand, { encoding: 'utf8' });
    const clientConfig = JSON.parse(clientOutput);

    console.log("✅ Retrieved current user pool client configuration");

    // Update the callback URLs and logout URLs
    const currentCallbackUrls = clientConfig.UserPoolClient.CallbackURLs || [];
    const currentLogoutUrls = clientConfig.UserPoolClient.LogoutURLs || [];

    // Add the new URLs if they don't already exist
    const updatedCallbackUrls = [...new Set([...currentCallbackUrls, callbackUrl])];
    const updatedLogoutUrls = [...new Set([...currentLogoutUrls, signoutUrl])];

    console.log("📋 Current callback URLs:");
    currentCallbackUrls.forEach((url: string) => console.log(`   - ${url}`));
    console.log("📋 Updated callback URLs:");
    updatedCallbackUrls.forEach((url: string) => console.log(`   - ${url}`));

    console.log("📋 Current logout URLs:");
    currentLogoutUrls.forEach((url: string) => console.log(`   - ${url}`));
    console.log("📋 Updated logout URLs:");
    updatedLogoutUrls.forEach((url: string) => console.log(`   - ${url}`));

    // Update the user pool client
    console.log("\n🚀 Updating Cognito User Pool Client...");
    const updateCommand = `aws cognito-idp update-user-pool-client \
      --user-pool-id ${userPoolId} \
      --client-id ${userPoolClientId} \
      --callback-urls ${updatedCallbackUrls.join(' ')} \
      --logout-urls ${updatedLogoutUrls.join(' ')} \
      --supported-identity-providers COGNITO \
      --allowed-o-auth-flows code \
      --allowed-o-auth-scopes email openid profile \
      --allowed-o-auth-flows-user-pool-client \
      --profile ${profile} \
      --region ${region}`;

    console.log(`Running: ${updateCommand}`);
    execSync(updateCommand, { stdio: 'inherit' });

    console.log("✅ Cognito User Pool Client updated successfully!");
    console.log("\n📋 Updated configuration:");
    console.log(`   User Pool ID: ${userPoolId}`);
    console.log(`   Client ID: ${userPoolClientId}`);
    console.log(`   Callback URLs: ${updatedCallbackUrls.join(', ')}`);
    console.log(`   Logout URLs: ${updatedLogoutUrls.join(', ')}`);

    console.log("\n🎉 Cognito is now configured to work with your CloudFront distribution!");
    console.log("   Users can now authenticate through the CloudFront domain");

  } catch (error) {
    console.log(`❌ Error updating Cognito: ${error instanceof Error ? error.message : error}`);
  }
}

updateCognitoUrls(); 