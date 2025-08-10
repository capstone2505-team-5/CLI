import { Client } from 'pg';
import getRDSSecrets from './getRDSSecrets.js';
import { RDSSecrets } from './types';

const getProductionConfig = async (): Promise<Partial<Client>> => {
  const rdsSecrets = await getRDSSecrets();
  return {
    host: rdsSecrets.host,
    port: rdsSecrets.port,
    user: rdsSecrets.username,
    password: rdsSecrets.password,
    database: rdsSecrets.dbname,
    ssl: { rejectUnauthorized: false } as any
  };
};

const getLocalConfig = (): Partial<Client> => {
  return {
    host: process.env.LOCALPGHOST,
    port: 5432,
    user: process.env.LOCALPGUSER,
    password: process.env.LOCALPGPASSWORD,
    database: process.env.LOCALPGDATABASE,
    ssl: undefined
  };
};

const createDbClient = async (): Promise<Client> => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  console.log('Creating db client');
  const config = isProduction 
    ? await getProductionConfig()
    : getLocalConfig();
    
  const client = new Client(config);
  return client;
};

export default createDbClient;