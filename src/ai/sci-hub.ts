
'use server';
/**
 * @fileOverview Genkit flow to download a PDF from Sci-Hub for a given DOI.
 * Mimics the logic of fetching the redirect URL and then downloading the content,
 * using native fetch and socks-proxy-agent for compatibility with Next.js environment.
 * Returns the PDF content as a Base64 data URI or an error.
 *
 * - sciHubFlow - A function that handles the download process.
 * - SciHubInput - The input type for the sciHubFlow function.
 * - SciHubOutput - The return type for the sciHubFlow function (Base64 data URI or error).
 */
import { ai } from './ai-instance';
import { z } from 'zod';
import { SocksProxyAgent } from 'socks-proxy-agent';
// Ensure 'node-fetch-native' is installed if 'fetch' is not globally available in the Node version used by Next.js server components.
// If fetch is globally available (Node 18+ usually), this import might not be strictly needed, but it ensures compatibility.
import fetch, { Headers, Request, Response } from 'node-fetch-native';

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
    resolvedUrl: z.string().optional().describe("The final URL resolved from Sci-Hub."),
    errorMessage: z.string().optional().describe("Error message if the download failed."),
    contentType: z.string().optional().describe("The content type received from the final download URL."),
});
export type SciHubOutput = z.infer<typeof SciHubOutputSchema>;

// --- Proxy Configuration ---
// Set USE_PROXY to true if you want to use the proxy
const USE_PROXY = false; // Set to false to disable proxy
const proxyUrl = 'socks5://127.0.0.1:7890'; // Your SOCKS5 proxy address
const agent = USE_PROXY ? new SocksProxyAgent(proxyUrl) : undefined;
// --- End Proxy Configuration ---

const commonHeaders = {
    // Use a realistic user agent
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/', // Add referer
};

const fetchOptionsBase = {
    // method: 'GET', // Method is GET by default
    headers: commonHeaders,
    agent: agent, // Assign the agent if proxy is enabled
    timeout: 90000, // 90 seconds timeout
    redirect: 'follow', // Follow redirects for the initial URL resolution
} as RequestInit; // Cast to RequestInit


// Define the Genkit flow
const sciHubDownloadFlow = ai.defineFlow(
  {
    name: 'sciHubDownloadFlow',
    inputSchema: SciHubInputSchema,
    outputSchema: SciHubOutputSchema,
  },
  async (input: SciHubInput): Promise<SciHubOutput> => {
    const { doi } = input;
    // Try common Sci-Hub domains
    const sciHubDomains = ['sci-hub.se', 'sci-hub.st', 'sci-hub.ru', 'sci-hub.hk', 'sci-hub.tw'];
    let lastError: any = new Error('Failed to connect to any Sci-Hub mirror.'); // Default error
    let resolvedUrl: string | undefined = undefined;
    let finalContentType: string | null = null;

    console.log(`Starting download process for DOI: ${doi} ${USE_PROXY ? 'via proxy' : ''}`);

    for (const domain of sciHubDomains) {
        const initialSciHubUrl = `https://${domain}/${doi}`;
        try {
            console.log(`Step 1: Resolving URL for DOI: ${doi} from ${initialSciHubUrl}`);

            // === Step 1: Fetch initial URL to get redirects ===
            // We expect this to redirect, potentially multiple times. 'redirect: follow' handles this.
            // We need the *final* URL the browser would land on.
            const resolveResponse = await fetch(initialSciHubUrl, { ...fetchOptionsBase });

            // The 'response.url' property should hold the final URL after all redirects.
            resolvedUrl = resolveResponse.url;
            console.log(`Resolved URL for ${doi} from ${domain}: ${resolvedUrl}`);

            if (!resolveResponse.ok) {
                // Check if the initial resolution failed significantly (e.g., server error on Sci-Hub itself)
                 console.error(`Initial URL resolution failed for ${doi} from ${domain}. Status: ${resolveResponse.status}`);
                  let errorBody = '';
                 try { errorBody = await resolveResponse.text(); } catch {}
                 if (errorBody.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub (initial check).');
                 } else {
                    lastError = new Error(`Initial URL resolution failed with status ${resolveResponse.status}`);
                 }
                 continue; // Try next domain
            }


             // === Step 2: Fetch the content from the resolved URL ===
             // Now fetch the actual content from the URL we resolved.
             // Important: For *this* request, we might NOT want to follow redirects if the resolved URL *is* the PDF.
             // However, sometimes Sci-Hub puts an intermediary HTML page first, so following might still be needed.
             // Let's stick with 'follow' for now, but monitor the content type.
             console.log(`Step 2: Fetching content from resolved URL: ${resolvedUrl}`);
             const contentResponse = await fetch(resolvedUrl, {
                ...fetchOptionsBase,
                // Keep redirect: 'follow' as Sci-Hub might still serve an intermediary page before the PDF
             });

             finalContentType = contentResponse.headers.get('content-type');
             console.log(`Content response status for ${doi}: ${contentResponse.status}`);
             console.log(`Content response content-type: ${finalContentType}`);

             if (!contentResponse.ok) {
                 console.error(`Failed to fetch content from resolved URL ${resolvedUrl}. Status: ${contentResponse.status}`);
                  let errorBody = '';
                 try { errorBody = await contentResponse.text(); } catch {}
                 if (errorBody.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub (content fetch).');
                 } else {
                    lastError = new Error(`Content fetch failed with status ${contentResponse.status}`);
                 }
                 // Don't immediately continue to next domain if we got this far,
                 // it likely means the DOI is problematic on Sci-Hub itself.
                 return { success: false, resolvedUrl: resolvedUrl, errorMessage: lastError.message, contentType: finalContentType };
             }


            // === Step 3: Check content type and process ===
            if (finalContentType?.includes('application/pdf')) {
                // Success! We got the PDF.
                console.log(`Successfully received PDF content for ${doi}.`);
                const buffer = await contentResponse.arrayBuffer();
                if (buffer.byteLength === 0) {
                     console.error(`Received empty PDF buffer for ${doi} from ${resolvedUrl}`);
                     lastError = new Error('Downloaded PDF file is empty.');
                     // Consider this a failure for this domain attempt
                     continue;
                }
                const base64Pdf = Buffer.from(buffer).toString('base64');
                const dataUri = `data:application/pdf;base64,${base64Pdf}`;
                console.log(`Successfully generated data URI for ${doi}. Length: ${dataUri.length}`);
                return { success: true, dataUri, resolvedUrl: resolvedUrl, contentType: finalContentType };

            } else if (finalContentType?.includes('html')) {
                 // We got an HTML page instead of a PDF. This could be a captcha, "not found" page, etc.
                 console.warn(`Received HTML instead of PDF for DOI: ${doi} from ${resolvedUrl}.`);
                 const bodyText = await contentResponse.text();
                 if (bodyText.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub (HTML response).');
                 } else if (bodyText.toLowerCase().includes('captcha')) {
                    lastError = new Error('Sci-Hub requires CAPTCHA.');
                 } else {
                    lastError = new Error('Received HTML page instead of PDF (unknown reason).');
                 }
                 console.warn(`HTML Body (first 500 chars): ${bodyText.substring(0,500)}`);
                 // Continue to the next domain, as this one might be blocked or showing captcha
                 continue;

            } else {
                // Unexpected content type
                console.error(`Failed to download PDF for DOI: ${doi}. Unexpected content type: ${finalContentType} from ${resolvedUrl}.`);
                lastError = new Error(`Unexpected content type received: ${finalContentType ?? 'unknown'}`);
                 // Treat as failure for this domain
                 continue;
            }

        } catch (error: any) {
            console.error(`Error processing DOI ${doi} with domain ${domain}:`, error);
            lastError = error; // Store the last error and try the next domain
            // Check for specific errors like timeouts
            if (error.name === 'FetchError' && error.message.includes('timeout')) {
                 console.warn(`Timeout occurred for ${domain}. Trying next domain.`);
                 lastError = new Error('Download timed out.'); // Standardize timeout message
            } else if (error.name === 'AbortError'){ // Another way timeouts might manifest
                 console.warn(`AbortError (likely timeout) occurred for ${domain}. Trying next domain.`);
                 lastError = new Error('Download timed out.');
            }
        }
    }

    // If the loop completes without returning success
    console.error(`All attempts failed for DOI ${doi}. Last error:`, lastError?.message || lastError);
    let errorMessage = 'Failed to download from all Sci-Hub mirrors.';
    if (lastError instanceof Error) {
        errorMessage = lastError.message;
        // Standardize common errors
        if (errorMessage.toLowerCase().includes('article not found')) {
             errorMessage = 'Article not found on Sci-Hub.';
        } else if (errorMessage.toLowerCase().includes('captcha')) {
            errorMessage = 'Sci-Hub CAPTCHA required or content blocked.';
        } else if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('timed out')) {
            errorMessage = 'Download timed out. Sci-Hub might be slow or unreachable.';
        } else if (errorMessage.toLowerCase().includes('failed to fetch') || errorMessage.toLowerCase().includes('enetunreach') || errorMessage.toLowerCase().includes('econnrefused')) {
            errorMessage = 'Network error connecting to Sci-Hub mirror.';
        }
    } else if (typeof lastError === 'string') {
        errorMessage = lastError;
    }

    return { success: false, resolvedUrl: resolvedUrl, errorMessage, contentType: finalContentType };
  }
);

/**
 * Public wrapper function to call the Genkit flow.
 * @param input The input containing the DOI.
 * @returns A promise resolving to the SciHubOutput.
 */
export async function sciHubFlow(input: SciHubInput): Promise<SciHubOutput> {
  try {
      return await sciHubDownloadFlow(input);
  } catch (error: any) {
       console.error(`Critical error executing sciHubDownloadFlow for DOI ${input.doi}:`, error);
       // Ensure a consistent error format is returned
       return {
           success: false,
           errorMessage: `Flow execution failed: ${error.message || 'Unknown error'}`,
           // resolvedUrl and contentType might be undefined here
       };
  }
}
