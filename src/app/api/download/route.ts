import { NextResponse } from 'next/server';
import { downloadFromSciHub } from '@/services/scihub';

// IMPORTANT: This is a placeholder API route.
// Actually calling a Python script from here requires careful consideration
// regarding security, environment setup, and execution context (e.g., using child_process).
// A more robust solution might involve a separate microservice or serverless function
// dedicated to running the Python script.

export async function POST(request: Request) {
  try {
    const { dois } = await request.json();

    if (!Array.isArray(dois) || dois.length === 0) {
      return NextResponse.json({ error: 'Invalid input: DOIs array is required.' }, { status: 400 });
    }

    // Limit to trial number on the server-side as well for security
    const trialLimit = 3;
    const doisToProcess = dois.slice(0, trialLimit);

    // Call the (currently simulated) download function
    // In a real implementation, this is where you'd trigger the Python script execution.
    // Example using child_process (requires careful setup and security):
    // const { spawn } = require('child_process');
    // const pythonProcess = spawn('python', ['path/to/your/script.py', doisToProcess.join(',')]);
    // You would need to handle stdout, stderr, and exit codes from the Python script.
    const results = await downloadFromSciHub(doisToProcess);

    return NextResponse.json({ results });

  } catch (error) {
    console.error('API Error:', error);
    let errorMessage = 'Internal Server Error';
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    return NextResponse.json({ error: 'Failed to process download request.', details: errorMessage }, { status: 500 });
  }
}
