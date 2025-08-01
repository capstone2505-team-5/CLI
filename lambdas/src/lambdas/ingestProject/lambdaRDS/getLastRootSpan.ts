import { Client } from 'pg';

const getLatestRootSpanStartTime = async (client: Client): Promise<Date> => {
  console.log('Fetching latest root span start time.');

  try {
    const result = await client.query('SELECT MAX(start_time) FROM root_spans;');
    const rawDate = result.rows[0].max;
    console.log(rawDate);

    let date;
    if (rawDate) {
      date = new Date(rawDate);
      date.setMinutes(date.getMinutes() - 5); // 5-minute overlap
    } else {
      date = new Date();
      date.setFullYear(date.getFullYear() - 25);
      console.log('No root spans found — defaulting to 25 years ago');
    }

    console.log(`Using start time: ${date.toISOString()}`);
    return date;

  } catch (e) {
    console.error('Issue getting root span start time from the table');
    throw e;
  }
};

export default getLatestRootSpanStartTime