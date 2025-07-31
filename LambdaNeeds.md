*** All Lambdas ***
VPC ID
Subnet ID
Security groups:
- Need to allow outbound access to 0.0.0.0/0
- Allow outbound access to TCP port 5432 w/ destination being the sg of the rds.
- RDS sg needs a rule to allow inbound access from the security group of the lambdas.
Create a role with policies:
- SecretsManagerReadWrite (Allows lambda to access secrets)
- AWSLambdaBasicExecutionRole (Allows Lambda to write to cloudwatch logs)
- Custom policy - AllowInvokeGetProjectRootSpans:
{
	"Version": "2012-10-17",
	"Statement": [
		{
			"Effect": "Allow",
			"Action": "lambda:InvokeFunction",
			"Resource": arn of GetProjectRootSpans lambda
		}
	]
}
Using Node.js 22.x
Configure timeout for each function



*** RDS Table Lambda ***


*** GetAllProjects Lambda ***

PHOENIX_API_KEY_SECRET_NAME=phoenix_api_key
PHOENIX_API_URL=
SPAN_INGESTION_FUNCTION_NAME=ARN of getAllProjectRootSpans lambda

*** GetAllProjectRootSpans Lambda ***


PHOENIX_API_KEY_SECRET_NAME=phoenix_api_key
PHOENIX_API_URL=

*** EventBridge Schedule ***

Target type: lambda
Target: ARN of GetAllProjectsLambda
Rate: 5 minutes

I need to change the lambda code to retrieve the phoenix url from secrets.
