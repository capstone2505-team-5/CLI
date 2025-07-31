import { Client } from 'pg';
import getRDSSecrets from './getRDSSecrets.js';
import { RDSSecrets } from './types';

const createDbClient = async (): Promise<Client> => {
  const isProduction = process.env.NODE_ENV === 'production';

  const rdsSecrets: RDSSecrets = await getRDSSecrets();

  console.log('Creating db client');
  const client = new Client({
    host: isProduction ? rdsSecrets.host : process.env.LOCALPGHOST,
    port: isProduction ? rdsSecrets.port : 5432,
    user: isProduction ? rdsSecrets.username : process.env.LOCALPGUSER,
    password: isProduction ? rdsSecrets.password : process.env.LOCALPGPASSWORD,
    database: isProduction ? rdsSecrets.dbname : process.env.LOCALPGDATABASE,
    ssl: isProduction
      ? { rejectUnauthorized: false }  // use SSL in prod (RDS)
      : undefined                     // no SSL locally
  });

  return client
}

export default createDbClient