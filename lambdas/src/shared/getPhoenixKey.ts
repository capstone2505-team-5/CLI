import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const getPhoenixKey = async (): Promise<string> => {
  if (process.env.NODE_ENV !== 'production') {
    const localKey = process.env.PHOENIX_API_KEY;
    if (!localKey) throw new Error("Missing PHOENIX_API_KEY in .env");
    return localKey;
  }

  const secret_name = process.env.PHOENIX_API_KEY_SECRET_NAME;
  if (!secret_name) throw new Error("Missing PHOENIX_API_KEY_SECRET_NAME env variable");

  const client = new SecretsManagerClient({ region: "us-west-2" });

  try {
    console.log('Fetching Phoenix API key')
    const response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: "AWSCURRENT", // VersionStage defaults to AWSCURRENT if unspecified
      })
    );

    const secret = response.SecretString;
    if (!secret) throw new Error("SecretString is undefined");

    const parsedSecret = JSON.parse(secret);
    if (!parsedSecret["phoenixApiKey"]) throw new Error("phoenixApiKey missing in Secrets Manager response");

    return parsedSecret["phoenixApiKey"];

  } catch (error) {
    console.error("Failed to fetch Phoenix API key", error);
    throw error;
  }
  

};

export default getPhoenixKey;