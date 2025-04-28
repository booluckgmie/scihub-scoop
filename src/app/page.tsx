
'use client';

import type { FC } from 'react';
import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { sciHubFlow, type SciHubOutput } from '@/ai/sci-hub'; // Import the Genkit flow
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, AlertTriangle, Download, Loader2, FileWarning, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge'; // Import Badge component

// Polyfill fetch if running in a Node.js environment where it might not be global
// Although 'node-fetch-native' aims to solve this, explicit checks can be helpful.
if (typeof fetch === 'undefined') {
  console.warn("Global fetch is undefined. Attempting to use node-fetch-native polyfill if available.");
  // If 'node-fetch-native' was correctly installed and imported elsewhere (like in the flow),
  // this might not be strictly necessary, but serves as a fallback concept.
  // Avoid direct require here in client component. Rely on environment providing fetch.
}


const formSchema = z.object({
  dois: z.string().min(1, 'Please enter at least one DOI URL.'),
});

type FormValues = z.infer<typeof formSchema>;

// Update interface to match SciHubOutput and include the original DOI
interface DownloadStatusEntry {
  doi: string;
  success: boolean;
  downloadUrl?: string; // This will hold the data URI
  errorMessage?: string;
  contentType?: string; // Add content type for debugging
}

interface DownloadStatusProps {
  status: DownloadStatusEntry[];
}

const DownloadStatus: FC<DownloadStatusProps> = ({ status }) => {
  if (status.length === 0) {
    return null;
  }

  return (
    <Card className="mt-8 bg-card shadow-inner border border-border">
      <CardHeader className="pb-4">
        <CardTitle>Download Status</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {status.map((result) => (
            <li key={result.doi} className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 border border-border rounded-md bg-background hover:bg-muted/50 transition-colors">
               <div className="flex-1 min-w-0 mr-4 mb-2 sm:mb-0">
                 <span className="block truncate font-mono text-sm text-foreground">{result.doi}</span>
                 {result.contentType && (
                   <Badge variant="outline" className="mt-1 text-xs font-normal">
                     Type: {result.contentType.split(';')[0]} {/* Show only main type */}
                   </Badge>
                 )}
               </div>
              <div className="flex-shrink-0 flex items-center">
                {result.success && result.downloadUrl ? (
                   // Check if it's a data URI before creating download link
                  result.downloadUrl.startsWith('data:') ? (
                    <a
                      href={result.downloadUrl}
                      download={`${result.doi.replace(/[\/:.]/g, '_')}.pdf`}
                      className="flex items-center text-green-600 hover:text-green-700 hover:underline"
                      aria-label={`Download PDF for DOI ${result.doi}`}
                    >
                      <Download className="h-5 w-5 mr-2 flex-shrink-0" />
                      Download PDF
                    </a>
                  ) : (
                    // If it's a regular URL (future possibility)
                    <a
                      href={result.downloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center text-blue-600 hover:text-blue-700 hover:underline"
                      aria-label={`Open download link for DOI ${result.doi}`}
                    >
                      <ExternalLink className="h-5 w-5 mr-2 flex-shrink-0" />
                      Open Link
                    </a>
                  )
                ) : (
                  <div className="flex items-center text-destructive" title={result.errorMessage}>
                    <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
                    <span className="text-sm truncate">{result.errorMessage || 'Download Failed'}</span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};


export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatusEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      dois: '',
    },
  });

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setDownloadStatus([]); // Clear previous results
    setProgress(0);

    // 1. Parse and Validate DOIs
    const doiList = values.dois
      .split(/[\s,;\n]+/) // Split by comma, semicolon, newline, or whitespace
      .map((doi) => doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')) // Remove prefixes and trim
      .filter((doi) => doi.length > 5 && doi.includes('/')); // Basic DOI format check

    if (doiList.length === 0) {
        toast({
            variant: "destructive",
            title: "Invalid Input",
            description: "No valid DOIs found. Please enter valid DOIs separated by commas, semicolons, or newlines.",
        });
        setIsLoading(false);
        return;
    }

    // 2. Apply Trial Limit
    const trialLimit = 3;
    const doisToProcess = doiList.slice(0, trialLimit);
    const uniqueDoisToProcess = [...new Set(doisToProcess)]; // Process unique DOIs only

    if (doiList.length > trialLimit) {
        toast({
            title: "Trial Limit Notice",
            description: `Processing the first ${trialLimit} unique DOIs entered (found ${uniqueDoisToProcess.length}). Upgrade for unlimited downloads.`,
            duration: 5000, // Keep message longer
        });
    } else if (doisToProcess.length !== uniqueDoisToProcess.length) {
         toast({
            title: "Duplicate DOIs Removed",
            description: `Processing ${uniqueDoisToProcess.length} unique DOI(s).`,
            duration: 3000,
        });
    }


    // 3. Process DOIs using the Genkit Flow
    try {
        const totalSteps = uniqueDoisToProcess.length;
        let currentStep = 0;
        const results: DownloadStatusEntry[] = [];

        const updateProgress = () => {
            currentStep++;
            // Use Math.min to ensure progress doesn't exceed 100 due to rounding
            setProgress(Math.min(100, (currentStep / totalSteps) * 100));
        }

        // Process each unique DOI sequentially
        for (const doi of uniqueDoisToProcess) {
             let result: SciHubOutput | null = null; // Initialize result
             try {
                console.log(`Processing DOI: ${doi}`);
                result = await sciHubFlow({ doi }); // Call the flow
                console.log(`Result for ${doi}:`, result);

                results.push({
                    doi,
                    success: result.success,
                    downloadUrl: result.dataUri, // Store the data URI here
                    errorMessage: result.errorMessage,
                    contentType: result.contentType, // Store content type
                });

            } catch (flowError: any) {
                console.error(`Error processing flow for DOI ${doi}:`, flowError);
                 // Push error result even if the flow itself throws an error
                 results.push({
                    doi,
                    success: false,
                    errorMessage: flowError.message || 'Flow execution failed.',
                    contentType: result?.contentType, // Include content type if available
                });
            } finally {
                // Update progress and status after each DOI attempt (success or failure)
                updateProgress();
                 // Update status incrementally for better UI feedback
                setDownloadStatus([...results]); // Create a new array reference
            }
        }

        // Final progress update to ensure it reaches 100%
        setProgress(100);

        const successfulDownloads = results.filter(r => r.success).length;
        toast({
            title: "Processing Complete",
            description: `Finished processing ${uniqueDoisToProcess.length} DOI(s). ${successfulDownloads} successful download(s).`,
        });

    } catch (error) {
        console.error("Error during overall download process:", error);
        toast({
            variant: "destructive",
            title: "Processing Error",
            description: "An unexpected error occurred during the process.",
        });
         setProgress(0); // Reset progress on major error
    } finally {
        setIsLoading(false);
        // Optionally reset progress after a delay, or keep it at 100
        // setTimeout(() => setProgress(0), 5000);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 md:p-12 lg:p-24 bg-secondary">
      <Card className="w-full max-w-3xl shadow-lg border-border rounded-lg overflow-hidden bg-card">
        <CardHeader className="bg-card p-6 border-b border-border">
          <CardTitle className="text-3xl font-bold text-center text-primary">
            Sci-Hub Scope
          </CardTitle>
          <p className="text-muted-foreground text-center mt-2">
            Enter DOIs (separated by comma, semicolon, or newline) to download papers.
            <br/>
            <Badge variant="secondary" className="mt-2">Trial Version: Max 3 unique DOIs processed</Badge>
          </p>
        </CardHeader>
        <CardContent className="p-6 md:p-8">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="dois"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="dois-input" className="text-lg font-semibold text-foreground">DOI List</FormLabel>
                    <FormControl>
                      <Textarea
                        id="dois-input"
                        placeholder="e.g., 10.1038/nature12345&#10;10.1126/science.abcde67, 10.1016/j.cell.2020.01.001"
                        className="min-h-[150px] resize-y bg-background border-input focus:border-primary focus:ring-primary text-sm shadow-sm"
                        {...field}
                        aria-describedby="dois-description dois-message"
                      />
                    </FormControl>
                    <FormDescription id="dois-description" className="text-xs text-muted-foreground">
                      Paste your list of DOIs here. Separate them using commas, semicolons, or new lines. Prefixes like 'https://doi.org/' will be removed automatically.
                    </FormDescription>
                    <FormMessage id="dois-message" />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-2 text-base py-3 rounded-md shadow-md transition-all duration-200 ease-in-out active:scale-[0.98]"
                disabled={isLoading}
                aria-live="polite" // Announce loading state changes
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                    Processing DOIs...
                  </>
                ) : (
                  <>
                   <Download className="mr-2 h-5 w-5" aria-hidden="true" />
                    Download Papers (Trial)
                  </>
                )}
              </Button>
            </form>
          </Form>

          {isLoading && (
            <div className="mt-6 space-y-2" aria-label="Download progress">
              <Progress value={progress} className="w-full h-3 [&>div]:bg-accent rounded-full" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} />
              <p className="text-sm text-muted-foreground text-center">{`Processing... ${Math.round(progress)}%`}</p>
            </div>
          )}

          {/* Display download status only after loading is complete or if there are results */}
          {/* Ensure downloadStatus state is updated correctly for this to show */}
           {(downloadStatus.length > 0) && (
              <DownloadStatus status={downloadStatus} />
           )}

           {/* Show message if loading finished but no results were generated and form was submitted */}
           {!isLoading && downloadStatus.length === 0 && form.formState.isSubmitted && (
             <Card className="mt-8 bg-muted border-dashed border-border">
                <CardContent className="p-6 text-center text-muted-foreground">
                     <FileWarning className="h-10 w-10 mx-auto mb-4 text-muted-foreground/70" />
                    <p>No download attempts were processed or all failed.</p>
                    <p className="text-sm">Please check the entered DOIs and network connection, then try again.</p>
                </CardContent>
             </Card>
           )}


          <div className="mt-10 text-center text-muted-foreground text-sm border-t border-border pt-6">
            <p>Need unlimited downloads and faster processing?</p>
            {/* Placeholder for Telegram link/button */}
             <Button variant="link" className="text-accent p-0 h-auto mt-1 hover:underline disabled:opacity-50" disabled>
                Upgrade via Telegram (Coming Soon)
            </Button>
          </div>

        </CardContent>
      </Card>
       <footer className="text-center mt-8 text-xs text-muted-foreground">
        <p>Sci-Hub Scope - Trial Version</p>
        <p>Please use responsibly and respect copyright laws.</p>
       </footer>
    </main>
  );
}
