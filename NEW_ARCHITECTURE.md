# New Architecture - Error Analysis App Deployment

## Overview

This document describes the new deployment architecture that removes VPN dependency and implements a modern, scalable serverless infrastructure.

## What's Changed

### Removed Components
- ❌ **VPN Access**: No longer requires VPN CIDR blocks or VPN connection
- ❌ **EC2 Instance**: Replaced with serverless Lambda functions
- ❌ **Docker Containers**: Application now runs as Lambda functions
- ❌ **Manual SSH Access**: Replaced with API Gateway endpoints

### New Components

#### 🏗️ **Networking**
- **VPC**: Custom VPC with public/private subnets
- **NAT Gateway**: For Lambda outbound internet access
- **Internet Gateway**: For public subnet access
- **Route Tables**: Proper routing for public/private subnets

#### 🔧 **Backend Services**
- **RDS PostgreSQL**: Database in private subnet (maintained)
- **Lambda Functions**: Serverless backend logic
- **EventBridge Scheduler**: Automated ETL triggers
- **API Gateway**: RESTful API with Cognito authorization
- **Secrets Manager**: Secure credential storage (maintained)

#### 🎨 **Frontend**
- **S3 Bucket**: Private storage for static web assets
- **CloudFront Distribution**: Global CDN with HTTPS enforcement
- **Origin Access Control**: Secure S3 access

#### 🔐 **Security & Authentication**
- **Cognito User Pool**: User management and authentication
- **Cognito Hosted UI**: Sign-in/sign-up interface
- **Cognito Authorizer**: API Gateway authorization
- **IAM Roles**: Least privilege access

## Architecture Diagram

```
Internet
    ↓
CloudFront Distribution (us-east-1)
    ↓
S3 Bucket (Private)
    ↓
API Gateway
    ↓
Lambda Functions (Private Subnet)
    ↓
RDS PostgreSQL (Private Subnet)
```

## Key Benefits

### 🚀 **Scalability**
- Auto-scaling Lambda functions
- Global CloudFront distribution
- Managed database with read replicas capability

### 🔒 **Security**
- No VPN required
- Cognito handles authentication
- Private subnets for all backend services
- HTTPS enforcement

### 💰 **Cost Optimization**
- Pay-per-use Lambda pricing
- Single NAT Gateway
- CloudFront caching reduces origin requests

### 🛠️ **Maintenance**
- No EC2 instance management
- Automatic security patches
- Managed services reduce operational overhead

## Migration Guide

### From Old Architecture

1. **Backup Your Data**
   ```bash
   # Export your current database
   pg_dump --host=your-old-rds-endpoint --username=appuser --dbname=error_analysis > backup.sql
   ```

2. **Deploy New Infrastructure**
   ```bash
   # Install dependencies
   npm install
   
   # Build the project
   npm run build
   
   # Deploy new architecture
   npm run dev
   ```

3. **Migrate Data**
   ```bash
   # Import data to new RDS instance
   psql --host=new-rds-endpoint --username=appuser --dbname=error_analysis < backup.sql
   ```

4. **Update Frontend**
   - Upload your frontend assets to the new S3 bucket
   - Update API endpoints to use the new API Gateway URL
   - Integrate Cognito authentication

### Configuration Changes

#### Old Configuration
```typescript
interface DeploymentConfig {
  appName: string;
  vpcId: string;
  vpnCidrBlocks: string[]; // ❌ No longer needed
  openApiKey: string;
  phoenixApiKey: string;
  phoenixApiUrl: string;
  awsProfile: string;
}
```

#### New Configuration
```typescript
interface DeploymentConfig {
  appName: string;
  openApiKey: string;
  phoenixApiKey: string;
  phoenixApiUrl: string;
  awsProfile: string;
  
  // New Cognito Configuration
  cognitoDomain: string;
  cognitoRedirectUris: string[];
  allowSelfSignup: boolean;
  createAdminUser: boolean;
  adminEmail?: string;
  adminPassword?: string;
}
```

## Deployment Process

### 1. Interactive Deployment
```bash
npm run dev
```

The CLI will prompt for:
- AWS Profile selection
- Application name
- Cognito domain prefix
- Redirect URIs for authentication
- Self-signup preferences
- Admin user creation (optional)
- API keys

### 2. Outputs

After deployment, you'll get:
- **CloudFront URL**: Your application's public URL
- **API Gateway URL**: Backend API endpoints
- **Cognito Domain**: Authentication URL
- **S3 Bucket**: For frontend assets
- **Database Endpoint**: RDS connection details

## Security Considerations

### 🔐 **Authentication Flow**
1. User visits CloudFront URL
2. Frontend redirects to Cognito Hosted UI
3. User authenticates with Cognito
4. Cognito redirects back with authorization code
5. Frontend exchanges code for tokens
6. Frontend includes tokens in API requests
7. API Gateway validates tokens with Cognito

### 🛡️ **Network Security**
- All backend services in private subnets
- Lambda functions can only access RDS via security groups
- API Gateway provides controlled access to Lambda functions
- CloudFront enforces HTTPS and provides DDoS protection

## Cost Optimization

### 💡 **Tips**
- Use single NAT Gateway (not multi-AZ) for development
- Set appropriate Lambda timeouts
- Configure CloudFront caching rules
- Monitor RDS instance size and scale as needed

### 📊 **Estimated Costs** (us-west-2)
- **RDS**: ~$15/month (t3.micro)
- **Lambda**: ~$5-10/month (depending on usage)
- **CloudFront**: ~$1-5/month (depending on traffic)
- **API Gateway**: ~$1-3/month
- **S3**: ~$1/month
- **Cognito**: Free tier (50,000 MAUs)
- **EventBridge**: ~$1/month

**Total**: ~$25-35/month for typical usage

## Troubleshooting

### Common Issues

1. **Cognito Domain Already Exists**
   - Choose a unique domain prefix
   - Cognito domains are global

2. **Lambda Timeout**
   - Increase timeout in deployment configuration
   - Optimize Lambda function performance

3. **API Gateway CORS Issues**
   - Configure CORS settings in API Gateway
   - Update frontend to include proper headers

4. **CloudFront Not Updating**
   - Invalidate CloudFront cache
   - Check S3 bucket permissions

### Useful Commands

```bash
# Check deployment status
aws cloudformation describe-stacks --stack-name error-analysis-app-new-stack

# Get CloudFront distribution ID
aws cloudformation describe-stacks --stack-name error-analysis-app-new-stack --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' --output text

# Invalidate CloudFront cache
aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths "/*"

# Test API Gateway
curl -H "Authorization: Bearer YOUR_TOKEN" https://your-api-gateway-url/projects
```

## Next Steps

1. **Deploy the new architecture**
2. **Migrate your frontend code** to work with the new API endpoints
3. **Upload frontend assets** to the S3 bucket
4. **Test authentication flow** with Cognito
5. **Monitor costs** and optimize as needed
6. **Set up monitoring** with CloudWatch

## Support

For issues or questions:
1. Check CloudFormation events for deployment errors
2. Review CloudWatch logs for Lambda function issues
3. Verify IAM permissions for all services
4. Test API Gateway endpoints with proper authentication 