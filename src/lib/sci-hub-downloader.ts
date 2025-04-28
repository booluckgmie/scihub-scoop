
'use server';
/**
 * @fileOverview Server-side utility to download a PDF from Sci-Hub for a given DOI.
 * Uses axios for HTTP requests and supports SOCKS proxy.
 * Attempts to handle direct PDF responses and HTML pages containing download links.
 * Returns the PDF content as a Base64 data URI or an error.
 *
 * - downloadSciHubPdf - A function that handles the download process.
 * - SciHubInput - The input type for the downloadSciHubPdf function.
 * - SciHubOutput - The return type for the downloadSciHubPdf function (Base64 data URI or error).
 */
import { z } from 'zod';
import axios, { AxiosRequestConfig, AxiosResponse, ResponseType } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent'; // For potential HTTPS proxy support
import * as https from 'https';

// Define input schema using Zod
const SciHubInputSchema = z.object({
  doi: z.string().describe('The DOI of the paper to download.'),
});
export type SciHubInput = z.infer<typeof SciHubInputSchema>;

// Define output schema using Zod
const SciHubOutputSchema = z.object({
    success: z.boolean(),
    dataUri: z.string().optional().describe("The Base64 encoded data URI of the PDF file (e.g., 'data:application/pdf;base64,...'). Present only on success."),
    resolvedUrl: z.string().optional().describe("The final URL from which the PDF was downloaded or attempted."),
    errorMessage: z.string().optional().describe("Error message if the download failed."),
    contentType: z.string().optional().describe("The content type received from the final download URL."),
});
export type SciHubOutput = z.infer<typeof SciHubOutputSchema>;

// --- Proxy Configuration ---
const USE_PROXY = false; // Set to true to enable proxy
const proxyUrl = 'socks5://127.0.0.1:7890'; // Your proxy address (SOCKS5 in this case)
// --- End Proxy Configuration ---

const getAxiosAgent = (): https.Agent | undefined => {
    if (!USE_PROXY) return undefined;
    try {
        if (proxyUrl.startsWith('socks')) {
            console.log(`Using SOCKS proxy agent: ${proxyUrl}`);
            return new SocksProxyAgent(proxyUrl);
        } else if (proxyUrl.startsWith('http')) {
            console.log(`Using HTTPS proxy agent: ${proxyUrl}`);
            // Axios needs HttpsProxyAgent for http/https proxies when making HTTPS requests
            return new HttpsProxyAgent(proxyUrl);
        } else {
             console.warn(`Unsupported proxy protocol in URL: ${proxyUrl}`);
             return undefined;
        }
    } catch (e) {
        console.error("Failed to create proxy agent:", e);
        return undefined;
    }
}

const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.google.com/', // Adding a common referer
};

const getAxiosConfig = (responseType: ResponseType = 'text'): AxiosRequestConfig => {
    const agent = getAxiosAgent();
    const config: AxiosRequestConfig = {
        headers: commonHeaders,
        timeout: 90000, // 90 seconds timeout
        maxRedirects: 10, // Follow redirects (axios default is 5)
        responseType: responseType,
         // Validate status to handle non-2xx responses without throwing immediately
        validateStatus: function (status) {
            return status >= 200 && status < 500; // Accept 2xx, 3xx, 4xx
        },
    };
    if (agent) {
       config.httpsAgent = agent;
       // config.httpAgent = agent; // Uncomment if you need proxy for HTTP too
    }
    return config;
};

/**
 * Extracts the direct PDF download link from Sci-Hub HTML content.
 * Looks for patterns like onclick="location.href='//...pdf?download=true'".
 * @param html The HTML content as a string.
 * @returns The extracted URL (starting with https://) or null if not found.
 */
function extractPdfLinkFromHtml(html: string): string | null {
    // Regex to find the download link within onclick attribute or similar patterns
    // It looks for location.href='(//.../(?:pdf|zip))' optionally followed by ?download=true
    const regex = /location\.href='(\/\/.*?\/[^']+\.(?:pdf|zip))(?:\?download=true)?'/i;
    const match = html.match(regex);

    if (match && match[1]) {
        const extractedPath = match[1];
        console.log(`Found potential download link in HTML: ${extractedPath}`);
        // Ensure the URL starts with https://
        return extractedPath.startsWith('//') ? `https:${extractedPath}` : extractedPath;
    }

    // Fallback: Look for an <a> tag with href containing .pdf inside specific divs
    const anchorRegex = /<div id=["']?buttons?["']?.*?<a.*?href=["'](.*?\.pdf(?:[?#].*?)?)["']/is;
    const anchorMatch = html.match(anchorRegex);
    if (anchorMatch && anchorMatch[1]) {
        let extractedHref = anchorMatch[1];
         console.log(`Found potential anchor link in HTML: ${extractedHref}`);
         // If it's a relative path (common on Sci-Hub), we need the base URL context, which is hard without knowing the exact mirror structure.
         // We'll assume absolute URLs starting with // or http for now.
         if (extractedHref.startsWith('//')) {
            return `https:${extractedHref}`;
         } else if (extractedHref.startsWith('http')) {
            return extractedHref;
         } else {
            console.warn(`Found relative PDF link (${extractedHref}), cannot resolve without base URL.`);
            // Cannot reliably construct the full URL here without the base domain.
            return null;
         }
    }

    console.log("No direct PDF download link pattern found in the HTML.");
    return null;
}


/**
 * Attempts to download a PDF from Sci-Hub for the given DOI using Axios.
 * Handles direct PDF downloads and attempts to parse HTML for download links.
 * @param input The input containing the DOI.
 * @returns A promise resolving to the SciHubOutput.
 */
export async function downloadSciHubPdf(input: SciHubInput): Promise<SciHubOutput> {
    const validation = SciHubInputSchema.safeParse(input);
    if (!validation.success) {
        return { success: false, errorMessage: `Invalid input: ${validation.error.message}` };
    }

    const { doi } = validation.data;
    const sciHubDomains = ['sci-hub.se', 'sci-hub.st', 'sci-hub.ru', 'sci-hub.hk', 'sci-hub.tw'];
    let lastError: any = new Error('Failed to connect to any Sci-Hub mirror.');
    let finalDownloadUrl: string | undefined = undefined; // Track the URL used for the actual PDF download
    let finalContentType: string | undefined = undefined;


    console.log(`Starting download process for DOI: ${doi} ${USE_PROXY ? `via proxy ${proxyUrl}` : ''}`);

    for (const domain of sciHubDomains) {
        const initialSciHubUrl = `https://${domain}/${doi}`;
        let currentUrl = initialSciHubUrl; // URL being requested

        try {
            console.log(`Step 1: Initial request for DOI: ${doi} from ${currentUrl}`);

            // Make a GET request, requesting text initially to handle both HTML and potential PDF redirects
            let response: AxiosResponse;
            try {
                response = await axios.get(currentUrl, getAxiosConfig('text')); // Request text first
                currentUrl = response.request?.responseURL || response.request?._redirectable?._options?.href || currentUrl; // Get final URL after redirects
                finalContentType = response.headers['content-type']?.split(';')[0]; // Get content type without charset
                console.log(`Initial response from ${currentUrl}: Status=${response.status}, Content-Type=${finalContentType}`);
            } catch (initialError: any) {
                console.error(`Initial request failed for ${domain}:`, initialError.message || initialError);
                lastError = initialError;
                continue; // Try next domain
            }


            // Check status from the initial response
             if (response.status >= 400) {
                 let errorBody = typeof response.data === 'string' ? response.data : '';
                 console.error(`Initial request failed with status ${response.status} for ${currentUrl}`);
                 if (errorBody.toLowerCase().includes('article not found')) {
                     lastError = new Error('Article not found on Sci-Hub.');
                 } else if (errorBody.toLowerCase().includes('captcha')) {
                    lastError = new Error('Sci-Hub requires CAPTCHA.');
                 } else {
                    lastError = new Error(`Initial request failed with status ${response.status}`);
                 }
                  // If we got a 4xx error, it's likely the DOI is the issue, not the mirror
                 if (response.status < 500) {
                     return { success: false, resolvedUrl: currentUrl, errorMessage: lastError.message, contentType: finalContentType };
                 }
                 continue; // Try next domain for server errors (5xx)
             }


            // === Step 2: Check Content-Type and Process ===
            if (finalContentType?.includes('application/pdf')) {
                console.log(`Received direct PDF response for ${doi} from ${currentUrl}. Fetching binary content...`);
                finalDownloadUrl = currentUrl; // This is the direct download URL

                // Fetch the actual PDF content as arraybuffer
                let pdfResponse: AxiosResponse<ArrayBuffer>;
                 try {
                    pdfResponse = await axios.get(finalDownloadUrl, getAxiosConfig('arraybuffer'));
                 } catch (pdfError: any) {
                     console.error(`Failed to fetch direct PDF content from ${finalDownloadUrl}:`, pdfError.message || pdfError);
                     lastError = pdfError;
                     continue; // Try next domain
                 }

                 if (pdfResponse.status >= 400) {
                     console.error(`Direct PDF download failed with status ${pdfResponse.status} for ${finalDownloadUrl}`);
                     lastError = new Error(`Direct PDF download failed with status ${pdfResponse.status}`);
                     if (pdfResponse.status < 500) return { success: false, resolvedUrl: finalDownloadUrl, errorMessage: lastError.message, contentType: finalContentType };
                     continue; // Try next domain for 5xx
                 }

                const buffer = pdfResponse.data;
                if (!buffer || buffer.byteLength === 0) {
                    console.error(`Received empty PDF buffer for ${doi} from ${finalDownloadUrl}`);
                    lastError = new Error('Downloaded PDF file is empty.');
                    continue; // Try next domain, might be a temporary issue
                }
                const base64Pdf = Buffer.from(buffer).toString('base64');
                const dataUri = `data:application/pdf;base64,${base64Pdf}`;
                console.log(`Successfully generated data URI for ${doi} from direct PDF. Length: ${dataUri.length}`);
                return { success: true, dataUri, resolvedUrl: finalDownloadUrl, contentType: finalContentType };

            } else if (finalContentType?.includes('html')) {
                 const htmlContent = typeof response.data === 'string' ? response.data : '';
                 console.log(`Received HTML for ${doi} from ${currentUrl}. Attempting to extract PDF link...`);
                 // console.log(`HTML Body (first 500 chars): ${htmlContent.substring(0, 500)}`); // Optional: log HTML snippet

                 const extractedPdfUrl = extractPdfLinkFromHtml(htmlContent);

                 if (extractedPdfUrl) {
                    console.log(`Step 3: Found embedded PDF link: ${extractedPdfUrl}. Fetching PDF content...`);
                    finalDownloadUrl = extractedPdfUrl; // Update the final URL

                     // Fetch the actual PDF content from the extracted URL
                     let pdfResponse: AxiosResponse<ArrayBuffer>;
                     try {
                         // Add referer from the page we just parsed
                         const pdfConfig = getAxiosConfig('arraybuffer');
                         pdfConfig.headers = { ...pdfConfig.headers, 'Referer': currentUrl };
                         pdfResponse = await axios.get(finalDownloadUrl, pdfConfig);
                         finalContentType = pdfResponse.headers['content-type']?.split(';')[0]; // Update content type from final download
                     } catch (pdfError: any) {
                         console.error(`Failed to fetch PDF content from extracted link ${finalDownloadUrl}:`, pdfError.message || pdfError);
                         lastError = pdfError;
                         continue; // Try next domain
                     }

                     if (pdfResponse.status >= 400) {
                         console.error(`PDF download from extracted link failed with status ${pdfResponse.status} for ${finalDownloadUrl}`);
                         lastError = new Error(`PDF download from extracted link failed with status ${pdfResponse.status}`);
                         if (pdfResponse.status < 500) return { success: false, resolvedUrl: finalDownloadUrl, errorMessage: lastError.message, contentType: finalContentType };
                         continue; // Try next domain for 5xx
                     }

                     // Check content type AGAIN from the actual download response
                     if (!finalContentType?.includes('application/pdf')) {
                         console.error(`Extracted link ${finalDownloadUrl} did not return PDF. Content-Type: ${finalContentType}`);
                         lastError = new Error(`Extracted link did not provide a PDF (Content-Type: ${finalContentType ?? 'unknown'}).`);
                         continue; // Try next domain
                     }

                     const buffer = pdfResponse.data;
                     if (!buffer || buffer.byteLength === 0) {
                        console.error(`Received empty PDF buffer for ${doi} from extracted link ${finalDownloadUrl}`);
                        lastError = new Error('Downloaded PDF file is empty.');
                        continue; // Try next domain
                     }

                     const base64Pdf = Buffer.from(buffer).toString('base64');
                     const dataUri = `data:application/pdf;base64,${base64Pdf}`;
                     console.log(`Successfully generated data URI for ${doi} from extracted link. Length: ${dataUri.length}`);
                     return { success: true, dataUri, resolvedUrl: finalDownloadUrl, contentType: finalContentType };

                 } else {
                     // HTML received, but no recognizable download link found
                     console.warn(`HTML received from ${currentUrl}, but no download link found.`);
                      if (htmlContent.toLowerCase().includes('article not found')) {
                         lastError = new Error('Article not found on Sci-Hub (HTML response).');
                     } else if (htmlContent.toLowerCase().includes('captcha')) {
                        lastError = new Error('Sci-Hub requires CAPTCHA.');
                     } else {
                        lastError = new Error('There may be an issue loading the page, as it was unable to find a download link.');
                     }
                     // Treat as final failure for this DOI if no link found in HTML
                     return { success: false, resolvedUrl: currentUrl, errorMessage: lastError.message, contentType: finalContentType };
                 }

            } else {
                console.error(`Unexpected content type: ${finalContentType} for ${doi} from ${currentUrl}.`);
                lastError = new Error(`Unexpected content type received: ${finalContentType ?? 'unknown'}`);
                continue; // Try next domain
            }

        } catch (error: any) {
            console.error(`Error processing DOI ${doi} with domain ${domain}:`, error?.message || error);
            lastError = error;
             if (axios.isAxiosError(error)) {
                 if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                     console.warn(`Timeout occurred for ${domain}. Trying next domain.`);
                     lastError = new Error('Download timed out.');
                 } else if (error.response) {
                     console.warn(`Request failed with status ${error.response.status} for ${domain}.`);
                     // Treat 4xx errors on a specific mirror as potentially final for the DOI
                     if (error.response.status >= 400 && error.response.status < 500) {
                        let errorBody = '';
                         if (error.response.data && typeof error.response.data === 'string') {
                             errorBody = error.response.data;
                         } else if (error.response.data && error.response.config?.responseType === 'arraybuffer') {
                             try { errorBody = Buffer.from(error.response.data).toString('utf-8'); } catch {}
                         } else if (error.response.data && error.response.config?.responseType === 'text') {
                              errorBody = error.response.data;
                         }
                         if (errorBody.toLowerCase().includes('article not found')) {
                              lastError = new Error('Article not found on Sci-Hub.');
                         } else if (errorBody.toLowerCase().includes('captcha')) {
                             lastError = new Error('Sci-Hub requires CAPTCHA.');
                         } else {
                            lastError = new Error(`Request failed with status ${error.response.status}`);
                         }
                         return { success: false, resolvedUrl: currentUrl, errorMessage: lastError.message, contentType: finalContentType };
                     }
                 } else if (error.request) {
                      console.warn(`No response received for ${domain}. Network issue?`);
                      lastError = new Error('Network error: No response received from Sci-Hub mirror.');
                 }
            }
        }
    }

    // If the loop completes without success
    console.error(`All attempts failed for DOI ${doi}. Last error:`, lastError?.message || lastError);
    let errorMessage = 'Failed to download from all Sci-Hub mirrors.';
    if (lastError instanceof Error) {
        errorMessage = lastError.message;
        // Consolidate common error messages
        if (errorMessage.toLowerCase().includes('article not found')) {
             errorMessage = 'Article not found on Sci-Hub.';
        } else if (errorMessage.toLowerCase().includes('captcha')) {
            errorMessage = 'Sci-Hub CAPTCHA required or content blocked.';
        } else if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('timed out')) {
            errorMessage = 'Download timed out. Sci-Hub might be slow or unreachable.';
        } else if (errorMessage.includes('Network error') || errorMessage.toLowerCase().includes('enetunreach') || errorMessage.toLowerCase().includes('econnrefused') || errorMessage.includes('socket hang up')) {
            errorMessage = 'Network error connecting to Sci-Hub mirror.';
        } else if (errorMessage.includes('status code 404')) {
            errorMessage = 'Article not found on Sci-Hub (404).';
        } else if (errorMessage.includes('status')) {
            // Keep specific status errors if not already handled
        } else if (!errorMessage.startsWith('There may be an issue loading the page') && !errorMessage.startsWith('Extracted link did not provide')) {
             // Avoid overly generic message if a more specific HTML/content type error occurred
             errorMessage = `An unexpected error occurred: ${errorMessage}`;
        }
    } else if (typeof lastError === 'string') {
        errorMessage = lastError;
    }

    // Return the last URL attempted for download if available, otherwise the initial requested URL
    return { success: false, resolvedUrl: finalDownloadUrl || sciHubDomains.map(d => `https://${d}/${doi}`)[0], errorMessage, contentType: finalContentType };
}
