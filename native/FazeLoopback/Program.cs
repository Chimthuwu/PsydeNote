using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace FazeLoopback;

/// <summary>
/// WASAPI loopback helper for Faze.
///   list          -> enumerates audio render endpoints (stdout: JSON).
///   capture &lt;id&gt; [sampleRate]
///                -> starts WASAPI loopback capture (stdout: 32-bit float
///                   stereo PCM, little-endian), one Process to read.
///   play &lt;id&gt; [freqHz] [seconds]
///                -> renders a sine wave to the chosen render device.
///                   Helpful for verifying the capture pipeline without any
///                   other audio sources running.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("Usage:");
                Console.Error.WriteLine("  faze-loopback list");
                Console.Error.WriteLine("  faze-loopback capture <deviceId> [sampleRate]");
                Console.Error.WriteLine("  faze-loopback play <deviceId> [freqHz] [seconds]");
                return 1;
            }

            var mode = args[0].ToLowerInvariant();
            return mode switch
            {
                "list" => ListCommand(),
                "capture" => CaptureCommand(args),
                "play" => PlayCommand(args),
                _ => Fail($"unknown mode: {mode}"),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[faze-loopback] fatal: {ex}");
            return 2;
        }
    }

    private static int Fail(string msg)
    {
        Console.Error.WriteLine($"[faze-loopback] {msg}");
        return 1;
    }

    private static int ListCommand()
    {
        using var enumerator = new MMDeviceEnumerator();
        var defaultDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console);
        var devices = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);

        var payload = devices.Select(d => new
        {
            id = d.ID,
            name = d.FriendlyName,
            isDefault = d.ID == defaultDevice.ID,
            sampleRate = 48000,
            channels = 2,
        }).ToList();

        Console.Out.WriteLine(System.Text.Json.JsonSerializer.Serialize(payload));
        Console.Out.Flush();
        return 0;
    }

    private static int CaptureCommand(string[] args)
    {
        if (args.Length < 2) return Fail("capture mode requires a deviceId");
        int sampleRate = 48000;
        if (args.Length >= 3 && int.TryParse(args[2], out var sr)) sampleRate = sr;

        using var enumerator = new MMDeviceEnumerator();
        MMDevice? device = ResolveDevice(enumerator, args[1]);
        if (device == null) return Fail($"no such device: {args[1]}");

        try
        {
            // Use IeeeFloat explicitly so the audio engine delivers float samples.
            var format = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, 2);
            var capture = new WasapiLoopbackCapture(device) { WaveFormat = format };

            Console.Error.WriteLine(
                $"[faze-loopback] capturing from {device.FriendlyName} @ {sampleRate} Hz IEEE-float stereo");

            var stdout = Console.OpenStandardOutput();
            int callbackCount = 0;
            int lastLoggedAt = 0;
            int firstNonZero = -1;

            capture.DataAvailable += (_, e) =>
            {
                callbackCount++;
                if (e.BytesRecorded == 0)
                {
                    if (callbackCount <= 3)
                    {
                        Console.Error.WriteLine(
                            $"[faze-loopback] cb #{callbackCount}: 0 bytes (WF={capture.WaveFormat})");
                    }
                    return;
                }
                if (firstNonZero == -1)
                {
                    firstNonZero = callbackCount;
                    Console.Error.WriteLine(
                        $"[faze-loopback] first nonzero cb #{callbackCount}: {e.BytesRecorded} bytes (WF={capture.WaveFormat})");
                }
                // Sanity: must deliver IEEE float stereo.
                if (capture.WaveFormat.BitsPerSample != 32 || capture.WaveFormat.Channels != 2)
                {
                    Console.Error.WriteLine(
                        $"[faze-loopback] unexpected WaveFormat: {capture.WaveFormat}");
                    return;
                }
                stdout.Write(e.Buffer, 0, e.BytesRecorded);
                stdout.Flush();

                if (callbackCount - lastLoggedAt > 50)
                {
                    lastLoggedAt = callbackCount;
                    Console.Error.WriteLine(
                        $"[faze-loopback] heartbeat cb #{callbackCount}, e.BR={e.BytesRecorded}");
                }
            };

            capture.StartRecording();

            var done = new ManualResetEventSlim(false);
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.Set(); };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => done.Set();
            var stdinThread = new Thread(() =>
            {
                try
                {
                    using var stdin = Console.OpenStandardInput();
                    var buf = new byte[256];
                    while (stdin.Read(buf, 0, buf.Length) > 0) { /* drain */ }
                }
                catch { }
                done.Set();
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            done.Wait();
            Thread.Sleep(100);
            try { capture.StopRecording(); } catch { }
            stdout.Flush();
            Console.Error.WriteLine(
                $"[faze-loopback] exiting cleanly (callbacks: {callbackCount}, first nonzero: {firstNonZero})");
            return 0;
        }
        finally
        {
            device.Dispose();
        }
    }

    private static int PlayCommand(string[] args)
    {
        if (args.Length < 2) return Fail("play mode requires a deviceId");
        double freq = 440.0;
        double seconds = 4.0;
        if (args.Length >= 3 && double.TryParse(args[2], out var f)) freq = f;
        if (args.Length >= 4 && double.TryParse(args[3], out var s)) seconds = s;

        using var enumerator = new MMDeviceEnumerator();
        MMDevice? device = ResolveDevice(enumerator, args[1]);
        if (device == null) return Fail($"no such device: {args[1]}");

        try
        {
            var format = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
            var provider = new SineWaveProvider(format) { Frequency = freq, Amplitude = 0.4f };
            using var output = new WasapiOut(device, AudioClientShareMode.Shared, false, 100);
            output.Init(provider);
            output.Play();

            Console.Error.WriteLine($"[faze-loopback] playing {freq}Hz on {device.FriendlyName} for {seconds}s");

            Thread.Sleep((int)(seconds * 1000));
            output.Stop();
            return 0;
        }
        finally
        {
            device.Dispose();
        }
    }

    private static NAudio.CoreAudioApi.MMDevice ResolveDevice(MMDeviceEnumerator enumerator, string idOrName)
    {
        if (!string.IsNullOrEmpty(idOrName))
        {
            try { return enumerator.GetDevice(idOrName); }
            catch { /* fall through */ }
        }
        var candidates = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        var m = candidates.FirstOrDefault(d =>
            d.FriendlyName.Equals(idOrName, StringComparison.OrdinalIgnoreCase));
        if (m == null) throw new InvalidOperationException($"no such device: {idOrName}");
        return m;
    }
}

internal sealed class SineWaveProvider : IWaveProvider
{
    private readonly WaveFormat format;
    public double Frequency { get; set; } = 440.0;
    public float Amplitude { get; set; } = 0.4f;
    private long sampleIndex;

    public SineWaveProvider(WaveFormat fmt) { format = fmt; }

    public WaveFormat WaveFormat => format;

    public int Read(byte[] buffer, int offset, int count)
    {
        var floats = new float[count / 4];
        for (int i = 0; i < floats.Length; i += 2)
        {
            float sample = (float)(Amplitude * Math.Sin(2 * Math.PI * Frequency * sampleIndex / format.SampleRate));
            floats[i] = sample;
            floats[i + 1] = sample;
            sampleIndex++;
        }
        Buffer.BlockCopy(floats, 0, buffer, offset, count);
        return count;
    }
}
