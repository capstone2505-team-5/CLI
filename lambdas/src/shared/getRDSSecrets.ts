import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { RDSSecrets } from "./types";

const getRDSSecrets = async (): Promise<RDSSecrets> => {

  const secret_name = process.env.RDS_CREDENTIALS_SECRET_NAME;
  if (!secret_name) throw new Error("Missing RDS_CREDENTIALS_SECRET_NAME env variable");

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });

  try {
    console.log('Fetching RDS secrets')
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
      })
    );

    const secret = response.SecretString;
    if (!secret) throw new Error("SecretString is undefined");

    const parsedSecret = JSON.parse(secret);

    // Extract the required properties from the parsed secret
    const {
      password,
      dbname,
      engine,
      port,
      dbInstanceIdentifier,
      host,
      username
    } = parsedSecret;

    // Validate that all required properties exist
    if (!password || !dbname || !engine || !port || !dbInstanceIdentifier || !host || !username) {
      throw new Error("Missing required RDS secret properties");
    }

    return {
      password,
      dbname,
      engine,
      port,
      dbInstanceIdentifier,
      host,
      username
    };

  } catch (error) {
    console.error("Failed to fetch RDS key", error);
    throw error;
  }
};

export default getRDSSecrets;