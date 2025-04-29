
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
import { downloadSciHubPdf, type SciHubOutput, type SciHubInput } from '@/lib/sci-hub-downloader';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, AlertTriangle, Download, Loader2, FileWarning, ExternalLink, Info, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import JSZip from 'jszip';
import { dataUriToBlob } from '@/lib/utils'; // Import the helper function

// Polyfill fetch if running in a Node.js environment where it might not be global
// Although 'node-fetch-native' aims to solve this, explicit checks can be helpful.
if (typeof fetch === 'undefined') {
  // console.warn("Global fetch is undefined. Ensure Node version supports fetch or node-fetch-native is polyfilling.");
    // Commented out as we are now using axios which handles its own dependencies
}


const formSchema = z.object({
  dois: z.string().min(1, 'Please enter at least one DOI URL.'),
});

type FormValues = z.infer<typeof formSchema>;

// Update interface to match the updated SciHubOutput structure
interface DownloadStatusEntry extends SciHubOutput {
  doi: string;
  // success, dataUri, resolvedUrl, errorMessage, contentType are inherited from SciHubOutput
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
         <TooltipProvider>
            <ul className="space-y-3">
            {status.map((result) => (
                <li key={result.doi} className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 border border-border rounded-md bg-background hover:bg-muted/50 transition-colors">
                 <div className="flex-1 min-w-0 mr-4 mb-2 sm:mb-0">
                     <Tooltip>
                         <TooltipTrigger asChild>
                           <span className="block truncate font-mono text-sm text-foreground cursor-help">{result.doi}</span>
                         </TooltipTrigger>
                         <TooltipContent side="top" align="start">
                           <p>Original DOI: {result.doi}</p>
                           {result.resolvedUrl && <p>Resolved URL: {result.resolvedUrl}</p>}
                           {result.contentType && <p>Content Type: {result.contentType}</p>}
                         </TooltipContent>
                     </Tooltip>
                 </div>
                <div className="flex-shrink-0 flex items-center">
                    {result.success && result.dataUri ? (
                    <a
                        href={result.dataUri}
                        download={`${result.doi.replace(/[\/:.]/g, '_')}.pdf`} // Suggest filename based on DOI
                        className="flex items-center text-green-600 hover:text-green-700 hover:underline"
                        aria-label={`Download PDF for DOI ${result.doi}`}
                    >
                        <Download className="h-5 w-5 mr-2 flex-shrink-0" />
                        Download PDF
                    </a>
                    ) : (
                    <Tooltip>
                         <TooltipTrigger asChild>
                         <div className="flex items-center text-destructive cursor-help">
                             <AlertTriangle className="h-5 w-5 mr-2 flex-shrink-0" />
                             <span className="text-sm truncate max-w-[200px] sm:max-w-[300px]">
                             {result.errorMessage || 'Download Failed'}
                             </span>
                         </div>
                         </TooltipTrigger>
                         <TooltipContent side="top" align="end">
                           <p>{result.errorMessage || 'Download Failed'}</p>
                         </TooltipContent>
                     </Tooltip>
                    )}
                </div>
                </li>
            ))}
            </ul>
         </TooltipProvider>
      </CardContent>
    </Card>
  );
};


export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatusEntry[]>([]);
  const [progress, setProgress] = useState(0);
  const { toast } = useToast();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      dois: '',
    },
  });

  const successfulDownloads = downloadStatus.filter(r => r.success && r.dataUri);

  const onSubmit = async (values: FormValues) => {
    setIsLoading(true);
    setDownloadStatus([]); // Clear previous results
    setProgress(0);
    form.clearErrors(); // Clear previous form errors

    // 1. Parse and Validate DOIs
    const doiList = values.dois
      .split(/[\s,;\n]+/) // Split by comma, semicolon, newline, or whitespace
      .map((doi) => doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')) // Remove prefixes and trim
      .filter((doi) => doi.length > 5 && doi.includes('/')); // Basic DOI format check

    if (doiList.length === 0) {
        form.setError("dois", {
           type: "manual",
           message: "No valid DOIs found. Please enter valid DOIs separated by commas, semicolons, or newlines.",
        });
        toast({
            variant: "destructive",
            title: "Invalid Input",
            description: "No valid DOIs found in the input.",
        });
        setIsLoading(false);
        return;
    }

    // 2. Apply Trial Limit and Ensure Uniqueness
    const trialLimit = 300;
    const uniqueDois = [...new Set(doiList)]; // Process unique DOIs only
    const doisToProcess = uniqueDois.slice(0, trialLimit);


    if (uniqueDois.length > trialLimit) {
        toast({
            title: "Trial Limit Applied",
            description: `Processing the first ${trialLimit} unique DOIs (out of ${uniqueDois.length} unique found). Upgrade for unlimited downloads.`,
            duration: 5000,
        });
    } else if (doiList.length > uniqueDois.length) {
         toast({
            title: "Duplicates Removed",
            description: `Processing ${doisToProcess.length} unique DOI(s). Duplicates were ignored.`,
            duration: 3000,
        });
    }

    if (doisToProcess.length === 0) {
        // This case should theoretically not happen if validation passed, but good to have.
        toast({
            variant: "destructive",
            title: "No DOIs to Process",
            description: "After validation and deduplication, no DOIs remained.",
        });
        setIsLoading(false);
        return;
    }


    // 3. Process DOIs using the server-side function
    try {
        const totalSteps = doisToProcess.length;
        let currentStep = 0;
        const results: DownloadStatusEntry[] = [];

        const updateProgress = () => {
            currentStep++;
            setProgress(Math.min(100, (currentStep / totalSteps) * 100));
        }

        // Process each unique DOI sequentially
        for (const doi of doisToProcess) {
             let downloadResult: SciHubOutput | null = null; // Initialize result
             try {
                console.log(`Processing DOI: ${doi}`);
                // Call the server-side function directly
                downloadResult = await downloadSciHubPdf({ doi });
                console.log(`Result for ${doi}: Success=${downloadResult.success}, HasData=${!!downloadResult.dataUri}, Error=${downloadResult.errorMessage}`);

                results.push({
                    doi,
                    success: downloadResult.success,
                    dataUri: downloadResult.dataUri,
                    resolvedUrl: downloadResult.resolvedUrl,
                    errorMessage: downloadResult.errorMessage,
                    contentType: downloadResult.contentType,
                });

            } catch (downloadError: any) {
                console.error(`Unhandled error during download for DOI ${doi}:`, downloadError);
                 // Push error result even if the function itself throws an unexpected error
                 results.push({
                    doi,
                    success: false,
                    errorMessage: downloadError.message || 'Download function failed unexpectedly.',
                    // Other fields will be undefined
                });
            } finally {
                // Update progress and status after each DOI attempt (success or failure)
                updateProgress();
                 // Update status incrementally for better UI feedback
                setDownloadStatus([...results]); // Create a new array reference
            }
        }

        // Final progress update to ensure it reaches 100% if all steps completed
        if (currentStep === totalSteps) {
            setProgress(100);
        }

        const successfulDownloadsCount = results.filter(r => r.success).length;
        toast({
            title: "Processing Complete",
            description: `Finished processing ${doisToProcess.length} DOI(s). ${successfulDownloadsCount} download link(s) generated.`,
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
        // Optionally keep progress at 100 or reset after a delay
        // setTimeout(() => setProgress(0), 5000);
    }
  };

  const handleDownloadZip = async () => {
     if (successfulDownloads.length === 0) {
      toast({
        variant: "destructive",
        title: "No PDFs to Download",
        description: "There are no successfully downloaded PDFs to include in the ZIP file.",
      });
      return;
    }

    setIsZipping(true);
    toast({
      title: "Creating ZIP File",
      description: "Please wait while the PDF files are being zipped...",
    });

    const zip = new JSZip();

    try {
      successfulDownloads.forEach((result) => {
        if (result.dataUri) {
          const blob = dataUriToBlob(result.dataUri);
          const filename = `${result.doi.replace(/[\/:.]/g, '_')}.pdf`;
          zip.file(filename, blob, { binary: true });
        }
      });

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = zipUrl;
      link.download = 'sci-hub-scope-papers.zip'; // Suggested filename for the zip
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(zipUrl); // Clean up the object URL

      toast({
        title: "ZIP Download Started",
        description: "Your ZIP file containing the downloaded PDFs has started downloading.",
      });

    } catch (error: any) {
        console.error("Error creating ZIP file:", error);
        toast({
            variant: "destructive",
            title: "ZIP Creation Failed",
            description: error.message || "An unexpected error occurred while creating the ZIP file.",
        });
    } finally {
        setIsZipping(false);
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
            Enter DOIs (separated by comma, semicolon, or newline) to generate direct download links.
             <br />
             <Badge variant="secondary" className="mt-2 cursor-default">
                <Info className="h-3 w-3 mr-1.5" />
                Trial Version: Max 3 unique DOIs processed
             </Badge>
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
                        aria-invalid={!!form.formState.errors.dois} // Indicate invalid state for accessibility
                      />
                    </FormControl>
                    <FormDescription id="dois-description" className="text-xs text-muted-foreground">
                      Paste your list of DOIs here. Separate them using commas, semicolons, or new lines. Prefixes like 'https://doi.org/' will be removed automatically. PDFs download directly to your browser.
                    </FormDescription>
                    <FormMessage id="dois-message" />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-2 text-base py-3 rounded-md shadow-md transition-all duration-200 ease-in-out active:scale-[0.98]"
                disabled={isLoading || isZipping}
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
                    Generate Download Links (Trial)
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

          {/* Display download status and ZIP button */}
           {downloadStatus.length > 0 && (
            <>
              <DownloadStatus status={downloadStatus} />
              {successfulDownloads.length > 0 && (
                  <Button
                    onClick={handleDownloadZip}
                    className="w-full mt-6 bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-2 text-base py-3 rounded-md shadow-md transition-all duration-200 ease-in-out active:scale-[0.98]"
                    disabled={isZipping || isLoading}
                    aria-live="polite"
                  >
                    {isZipping ? (
                      <>
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
                        Creating ZIP...
                      </>
                    ) : (
                      <>
                        <Package className="mr-2 h-5 w-5" aria-hidden="true" />
                        Download All as ZIP ({successfulDownloads.length} file{successfulDownloads.length !== 1 ? 's' : ''})
                      </>
                    )}
                  </Button>
              )}
            </>
           )}

           {/* Show message if loading finished but no results were generated and form was submitted */}
           {!isLoading && downloadStatus.length === 0 && form.formState.isSubmitted && !form.formState.errors.dois && (
             <Card className="mt-8 bg-muted border-dashed border-border">
                <CardContent className="p-6 text-center text-muted-foreground">
                     <FileWarning className="h-10 w-10 mx-auto mb-4 text-muted-foreground/70" />
                    <p>No download attempts were processed or none were successful.</p>
                    <p className="text-sm">Please check the entered DOIs and network connection, then try again.</p>
                </CardContent>
             </Card>
           )}


          <div className="mt-10 text-center text-muted-foreground text-sm border-t border-border pt-6">
            <p>Need unlimited downloads and faster processing?</p>
            {/* Placeholder for Telegram link/button */}
             <Button variant="link" className="text-accent p-0 h-auto mt-1 hover:underline disabled:opacity-50" disabled>
                <ExternalLink className="h-4 w-4 mr-1.5"/>
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
