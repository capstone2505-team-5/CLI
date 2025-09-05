# LLMonade CLI Deployer

A streamlined deployment solution for error analysis applications on AWS infrastructure. This tool deploys your application on a serverless infrastructure and automatically imports your Phoenix traces to an RDS PostgreSQL database.

## Overview

This deployment tool creates a secure, production-ready serverless environment for manual error analysis with:

- **Lambda Functions**: Serverless compute for data processing and API endpoints
- **RDS PostgreSQL**: Managed database with automated backups
- **API Gateway**: RESTful API with Cognito authentication
- **CloudFront**: Global content delivery with Lambda@Edge authentication
- **Cognito**: User authentication and authorization
- **S3**: Static frontend hosting
- **EventBridge**: Scheduled data synchronization

## Prerequisites

Before deploying, ensure you have:

1. **AWS CLI** configured with appropriate permissions
2. **CDK CLI** installed: `npm install -g aws-cdk`
3. **Node.js 16+** installed
4. **Phoenix API access** with valid credentials
5. **OpenAI API key**

## Quick Start

### 1. Setup Environment
```bash
git clone <repository-url>
cd error-analysis-deployer
npm install
```

### 2. Deploy Application
```bash
npm run dev
```

### 3. Configuration
The deployment process will prompt for:
- **Application name**: Defaults to `error-analysis-app`
- **AWS Profile**: Your configured AWS profile
- **AWS Region**: Target deployment region
- **Availability Zones**: For VPC and database placement
- **Cognito Domain**: Unique domain prefix for authentication
- **OpenAI API Key**: For AI-powered error analysis
- **Phoenix API Key**: For Phoenix integration
- **Phoenix API URL**: Phoenix service endpoint

## Architecture

### Infrastructure Components
- **Lambda Functions**: Serverless compute for data processing, API endpoints, and scheduled tasks
- **RDS Database**: PostgreSQL instance with automated backups and encryption
- **VPC**: Private networking with isolated database subnets
- **API Gateway**: RESTful API with Cognito authorization
- **CloudFront**: Global CDN with Lambda@Edge authentication
- **Cognito**: User pool with hosted UI for authentication
- **S3**: Static frontend asset hosting
- **EventBridge**: Scheduled Lambda execution for data synchronization
- **Secrets Manager**: Secure storage for API keys and database credentials

### Lambda Functions
The deployment creates several Lambda functions:
- **Database Creation**: Initializes database schema and tables
- **Project Management**: Fetches and manages Phoenix projects
- **Data Ingestion**: Processes Phoenix traces and root spans
- **API Endpoints**: Express.js API for frontend communication
- **Batch Processing**: Handles large-scale data formatting

### Authentication Flow
1. **Cognito Hosted UI**: Users authenticate via Cognito
2. **Lambda@Edge**: Validates authentication tokens on CloudFront
3. **API Gateway**: Authorizes API requests using Cognito tokens
4. **Seamless Experience**: Single sign-on across the application

## Access and Management

### Application Access
1. Access the application via CloudFront URL
2. Sign in through Cognito hosted UI
3. Navigate the error analysis dashboard
4. API endpoints available at `/api/*` paths

### System Management
```bash
# Check Lambda function status
aws lambda list-functions --profile <profile> --region <region>

# View CloudWatch logs
aws logs describe-log-groups --profile <profile> --region <region>

# Monitor API Gateway
aws apigateway get-rest-apis --profile <profile> --region <region>
```

### Database Management
- **Connection**: Automatically configured in Lambda functions
- **Credentials**: Stored securely in AWS Secrets Manager
- **Database**: `error_analysis` (auto-created)
- **Backups**: Automated daily backups with 7-day retention

### Support
For deployment issues, check:
- AWS CloudFormation console for stack events
- CloudWatch logs for Lambda function errors
- API Gateway console for endpoint status
- CloudFront console for distribution health
