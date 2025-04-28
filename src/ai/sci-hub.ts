
'use server';
/**
 * @fileOverview Genkit flow to download a PDF from Sci-Hub for a given DOI.
 * Uses native fetch and socks-proxy-agent for compatibility with Next.js environment.
 *
 * - sciHubFlow - A function that handles the download process.
 * - SciHubInput - The input type for the sciHubFlow function.
 * - SciHubOutput - The return type for the sciHubFlow function (Base64 data URI or error).
 */
import { ai } from './ai-instance';
import { z } from 'zod';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { fetch } from 'node-fetch-native'; // Use node-fetch-native for reliable fetch in Node

// Define input schema using Zod
const SciHubInputSchema = z.object({
  doi: z.string().describe('The DOI of the paper to download.'),
});
export type SciHubInput = z.infer<typeof SciHubInputSchema>;

// Define output schema using Zod
// Output will be a Base64 encoded data URI for the PDF or an error message
const SciHubOutputSchema = z.object({
    success: z.boolean(),
    dataUri: z.string().optional().describe("The Base64 encoded data URI of the PDF file (e.g., 'data:application/pdf;base64,...'). Present only on success."),
    errorMessage: z.string().optional().describe("Error message if the download failed."),
    contentType: z.string().optional().describe("The content type received from Sci-Hub."),
});
export type SciHubOutput = z.infer<typeof SciHubOutputSchema>;


// Define the Genkit flow
const sciHubDownloadFlow = ai.defineFlow(
  {
    name: 'sciHubDownloadFlow',
    inputSchema: SciHubInputSchema,
    outputSchema: SciHubOutputSchema,
  },
  async (input: SciHubInput): Promise<SciHubOutput> => {
    const { doi } = input;
    // Try common Sci-Hub domains or mirrors if one fails (optional, starting with .se)
    const sciHubDomains = ['sci-hub.se', 'sci-hub.st', 'sci-hub.ru'];
    let lastError: any = null;
    let contentTypeReceived: string | null = null;

    // --- Proxy Configuration ---
    // Set USE_PROXY to true if you want to use the proxy
    const USE_PROXY = false; // Set to false to disable proxy
    const proxyUrl = 'socks5://127.0.0.1:7890'; // Your SOCKS5 proxy address
    const agent = USE_PROXY ? new SocksProxyAgent(proxyUrl) : undefined;
    // --- End Proxy Configuration ---

    const fetchOptions = {
        method: 'GET',
        headers: {
          // Use a realistic user agent
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.google.com/', // Add referer
        },
        agent: agent, // Assign the agent if proxy is enabled
        timeout: 60000, // 60 seconds timeout
        redirect: 'follow', // Follow redirects (Sci-Hub often redirects)
    } as RequestInit; // Cast to RequestInit

    for (const domain of sciHubDomains) {
        const sciHubUrl = `https://${domain}/${doi}`;
        try {
            console.log(`Attempting to download DOI: ${doi} from ${sciHubUrl} ${USE_PROXY ? 'via proxy' : ''}`);

            const response = await fetch(sciHubUrl, fetchOptions);
            contentTypeReceived = response.headers.get('content-type');

            console.log(`Response status for ${doi} from ${domain}: ${response.status}`);
            console.log(`Response content-type: ${contentTypeReceived}`);


            if (!response.ok) {
                 console.error(`HTTP error ${response.status} for DOI ${doi} from ${domain}`);
                 // Try reading body for more info even on error
                 try {
                    const errorBody = await response.text();
                    console.error(`Error response body (first 500 chars): ${errorBody.substring(0, 500)}`);
                     if (errorBody.toLowerCase().includes('article not found')) {
                        lastError = new Error('Article not found on Sci-Hub.');
                        continue; // Try next domain
                    }
                     if (response.status === 404) {
                         lastError = new Error('Article not found (404).');
                         continue; // Try next domain
                     }
                 } catch (readError) {
                    console.error('Could not read error response body:', readError);
                 }
                 lastError = new Error(`HTTP error ${response.status}`);
                 continue; // Try next domain
            }

            // Check if the downloaded content is actually a PDF
            if (contentTypeReceived?.includes('application/pdf')) {
                const buffer = await response.arrayBuffer();
                const base64Pdf = Buffer.from(buffer).toString('base64');
                const dataUri = `data:application/pdf;base64,${base64Pdf}`;
                console.log(`Successfully generated data URI for ${doi}. Length: ${dataUri.length}`);
                return { success: true, dataUri, contentType: contentTypeReceived };
            } else if (contentTypeReceived?.includes('html')) {
                 // Handle cases where Sci-Hub returns an HTML page (e.g., captcha, intermediary page)
                 console.warn(`Received HTML instead of PDF for DOI: ${doi} from ${domain}. Status: ${response.status}`);
                 const bodyText = await response.text();
                 // Basic check for common 'not found' text within HTML
                 if (bodyText.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub (HTML response).');
                     continue; // Try next domain
                 }
                 // You might need more sophisticated checks for captchas or other issues here
                 lastError = new Error('Received HTML page instead of PDF. Possible captcha or other issue.');
                 continue; // Try next domain, maybe another mirror works
            } else {
                // Handle other unexpected content types or empty body
                console.error(`Failed to download PDF for DOI: ${doi}. Unexpected content type: ${contentTypeReceived} from ${domain}.`);
                lastError = new Error(`Failed to retrieve PDF. Unexpected content type: ${contentTypeReceived ?? 'unknown'}`);
                // Continue might be appropriate, but let's stop if the first domain gives weird content
                // Consider if you want to try other domains even in this case
                 return { success: false, errorMessage: lastError.message, contentType: contentTypeReceived };
            }
        } catch (error: any) {
            console.error(`Error downloading DOI ${doi} from ${domain}:`, error);
            lastError = error; // Store the last error and try the next domain
        }
    }

    // If loop completes without success
    console.error(`All attempts failed for DOI ${doi}. Last error:`, lastError);
    let errorMessage = 'Failed to download from all Sci-Hub mirrors.';
    if (lastError instanceof Error) {
        errorMessage = lastError.message;
         // Check for timeout specifically
        if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('timed out')) {
            errorMessage = 'Download timed out. Sci-Hub might be slow or unreachable.';
        }
    } else if (typeof lastError === 'string') {
        errorMessage = lastError;
    }

    return { success: false, errorMessage, contentType: contentTypeReceived };
  }
);

/**
 * Public wrapper function to call the Genkit flow.
 * @param input The input containing the DOI.
 * @returns A promise resolving to the SciHubOutput.
 */
export async function sciHubFlow(input: SciHubInput): Promise<SciHubOutput> {
  // Add a retry mechanism here if desired, or handle specific flow errors
  try {
      return await sciHubDownloadFlow(input);
  } catch (error: any) {
       console.error(`Critical error executing sciHubDownloadFlow for DOI ${input.doi}:`, error);
       return { success: false, errorMessage: `Flow execution failed: ${error.message || 'Unknown error'}` };
  }
}

// Example of how to potentially add node-fetch-native globally if needed,
// although importing directly is generally preferred.
// try {
//   if (typeof global.fetch === 'undefined') {
//     const { fetch, Headers, Request, Response } = require('node-fetch-native');
//     global.fetch = fetch;
//     global.Headers = Headers;
//     global.Request = Request;
//     global.Response = Response;
//   }
// } catch (e) {
//   console.error("Failed to polyfill fetch:", e);
// }
