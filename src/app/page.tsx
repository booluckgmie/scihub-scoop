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
import { downloadFromSciHub, type DownloadResult } from '@/services/scihub';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, AlertTriangle, Download, Loader2 } from 'lucide-react';

const formSchema = z.object({
  dois: z.string().min(1, 'Please enter at least one DOI URL.'),
});

type FormValues = z.infer<typeof formSchema>;

interface DownloadStatusProps {
  status: DownloadResult[];
}

const DownloadStatus: FC<DownloadStatusProps> = ({ status }) => {
  if (status.length === 0) {
    return null;
  }

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Download Status</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {status.map((result) => (
            <li key={result.doi} className="flex items-center justify-between p-3 border rounded-md">
              <span className="truncate mr-4">{result.doi}</span>
              {result.success ? (
                <div className="flex items-center text-green-600">
                  <CheckCircle className="h-5 w-5 mr-2" />
                  <a href={result.downloadUrl} target="_blank" rel="noopener noreferrer" className="flex items-center hover:underline">
                    <Download className="h-5 w-5 mr-1" />
                    Download
                  </a>
                </div>
              ) : (
                <div className="flex items-center text-destructive">
                  <AlertTriangle className="h-5 w-5 mr-2" />
                  <span>{result.errorMessage || 'Failed'}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};


export default function Home() {
  const [isLoading, setIsLoading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DownloadResult[]>([]);
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
    setDownloadStatus([]);
    setProgress(0);

    const doiList = values.dois
      .split(',')
      .map((doi) => doi.trim())
      .filter((doi) => doi.length > 0);

    if (doiList.length === 0) {
        toast({
            variant: "destructive",
            title: "Invalid Input",
            description: "Please enter valid DOI URLs separated by commas.",
        });
        setIsLoading(false);
        return;
    }

    const trialLimit = 3;
    const doisToProcess = doiList.slice(0, trialLimit);

    if (doiList.length > trialLimit) {
        toast({
            title: "Trial Limit Reached",
            description: `You can download up to ${trialLimit} files in the trial version. Only the first ${trialLimit} DOIs will be processed.`,
        });
    }

    try {
        // Simulate progress for placeholder SciHub interaction
        const totalSteps = doisToProcess.length;
        let currentStep = 0;

        const updateProgress = () => {
            currentStep++;
            setProgress((currentStep / totalSteps) * 100);
        }

        const results: DownloadResult[] = [];
        for (const doi of doisToProcess) {
            // Placeholder for actual SciHub call
            // In a real scenario, you'd call downloadFromSciHub here
            // and handle its response.
             const result = await new Promise<DownloadResult>(resolve => {
                setTimeout(() => {
                   const success = Math.random() > 0.2; // Simulate success/failure
                   resolve({
                       doi,
                       success: success,
                       downloadUrl: success ? `https://example.com/download/${doi.replace(/[\/:.]/g, '_')}.pdf` : undefined,
                       errorMessage: success ? undefined : 'File not found on Sci-Hub',
                   })
                   updateProgress();
                }, 1000); // Simulate network delay
            });
            results.push(result);
            setDownloadStatus([...results]); // Update status incrementally
        }

        // Final update after loop finishes, in case of rounding issues
        setProgress(100);

        toast({
            title: "Processing Complete",
            description: `Finished processing ${doisToProcess.length} DOI(s).`,
        });
    } catch (error) {
        console.error("Error during download process:", error);
        toast({
            variant: "destructive",
            title: "Error",
            description: "An unexpected error occurred during the download process.",
        });
    } finally {
        setIsLoading(false);
        // Keep progress bar at 100% after completion
        // setTimeout(() => setProgress(0), 2000); // Optionally reset progress after a delay
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 md:p-24 bg-secondary">
      <Card className="w-full max-w-2xl shadow-lg">
        <CardHeader>
          <CardTitle className="text-3xl font-bold text-center text-primary">Sci-Hub Scope</CardTitle>
          <p className="text-muted-foreground text-center">
            Enter DOI URLs separated by commas to download papers (Trial: Max 3).
          </p>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="dois"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="dois-input" className="text-lg font-semibold">DOI URLs</FormLabel>
                    <FormControl>
                      <Textarea
                        id="dois-input"
                        placeholder="e.g., 10.1038/nature12345, 10.1126/science.abcde67"
                        className="min-h-[150px] resize-y"
                        {...field}
                        aria-describedby="dois-description dois-message"
                      />
                    </FormControl>
                    <FormDescription id="dois-description">
                      Separate multiple DOI URLs with commas.
                    </FormDescription>
                    <FormMessage id="dois-message" />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  'Download Papers'
                )}
              </Button>
            </form>
          </Form>

          {isLoading && (
            <div className="mt-6 space-y-2">
              <Progress value={progress} className="w-full h-3 [&>div]:bg-accent" />
              <p className="text-sm text-muted-foreground text-center">{`Processing... ${Math.round(progress)}%`}</p>
            </div>
          )}

          <DownloadStatus status={downloadStatus} />

          <div className="mt-8 text-center text-muted-foreground text-sm">
            <p>Need unlimited downloads? Get full access via Telegram.</p>
            {/* Add a link/button to Telegram or payment page here later */}
             <Button variant="link" className="text-accent p-0 h-auto mt-1" >
                Learn More
            </Button>
          </div>

        </CardContent>
      </Card>
    </main>
  );
}
