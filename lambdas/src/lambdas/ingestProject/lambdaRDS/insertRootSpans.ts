import { Client } from "pg";
import { RootSpan } from "../types/types";

const insertRootSpans = async (client: Client, rootSpans: RootSpan[]): Promise<void> => {
  if (rootSpans.length === 0) {
    console.log('No root spans to insert.');
    return;
  }
  
  console.log('Inserting root spans into database');
  await client.query('BEGIN');

  try {
    const insertQuery = `
      INSERT INTO root_spans (
        id, trace_id, input, output, project_id, span_name, start_time, end_time
      )
      VALUES ${rootSpans.map((_, i) => `(
        $${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4},
        $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}
      )`).join(', ')}
      ON CONFLICT (id) DO NOTHING
    `;

    const values = rootSpans.flatMap(span => [
      span.id,
      span.traceId,
      span.input,
      span.output,
      span.projectId,
      span.spanName,
      span.startTime,
      span.endTime,
    ]);

    await client.query(insertQuery, values);
    await client.query('COMMIT');
    console.log('Root span data successfully added');
  } catch (e) {
    console.log('Root span data addition failed.');
    await client.query('ROLLBACK');
    throw e;
  }
}

export default insertRootSpans