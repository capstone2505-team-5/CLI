import createDbClient from "../../shared/createDbClient.js"

export const handler = async () => {
  let client

  try {
    client = await createDbClient();
    client.connect();

    // Drop all existing tables
    const dropAllTablesSQL = `
      DO $$ 
      DECLARE 
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = current_schema()) LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `;

    await client.query(dropAllTablesSQL);
    console.log('All existing tables dropped successfully');

    // Create tables
    const createTablesSQL = `
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(50) PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NULL,
        root_span_count INTEGER NOT NULL,
        last_cursor TEXT NULL
      );
      
      CREATE TABLE IF NOT EXISTS batches (
        id VARCHAR(50) PRIMARY KEY,
        project_id VARCHAR(50) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS root_spans (
        id VARCHAR(50) PRIMARY KEY,
        trace_id VARCHAR(50) NOT NULL,
        batch_id VARCHAR(50) REFERENCES batches(id) ON DELETE SET NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        project_id VARCHAR(50) REFERENCES projects(id) NOT NULL,
        span_name VARCHAR(50) NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );  

      CREATE TABLE IF NOT EXISTS annotations (
        id VARCHAR(50) PRIMARY KEY,
        root_span_id VARCHAR(50) REFERENCES root_spans(id) ON DELETE CASCADE,
        note TEXT,
        rating TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(50) PRIMARY KEY,
        text TEXT
      );

      CREATE TABLE IF NOT EXISTS annotation_categories (
        id VARCHAR(50) PRIMARY KEY,
        annotation_id VARCHAR(50) NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
        category_id VARCHAR(50) NOT NULL REFERENCES categories(id) ON DELETE CASCADE
      );
    `;

    await client.query(createTablesSQL);
    console.log('Tables created successfully');

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Database tables dropped and recreated successfully' }),
      headers: {
        'Content-Type': 'application/json',
      },
    };
    
  }catch (error: any) {
    console.error('Error in handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: error.message || 'Internal Server Error' }),
      headers: {
        'Content-Type': 'application/json',
      },
    };
  } finally {
    if(client){
      client.end();
      console.log('DB connection closed...')
    }
  }

}

