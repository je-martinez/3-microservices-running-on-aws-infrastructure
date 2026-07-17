using System.IO;
using System.Text.Json;
using Serilog.Events;
using Serilog.Formatting;

namespace Orders.Api.Logging;

// Emits one JSON line per event in the shared snake_case OTel-aligned schema.
public sealed class SchemaLogFormatter : ITextFormatter
{
    private readonly string _serviceName;
    private readonly string _environment;

    private static readonly Dictionary<LogEventLevel, (string Text, int Number)> Severity = new()
    {
        [LogEventLevel.Verbose] = ("DEBUG", 5),
        [LogEventLevel.Debug] = ("DEBUG", 5),
        [LogEventLevel.Information] = ("INFO", 9),
        [LogEventLevel.Warning] = ("WARN", 13),
        [LogEventLevel.Error] = ("ERROR", 17),
        [LogEventLevel.Fatal] = ("ERROR", 17),
    };

    public SchemaLogFormatter(string serviceName, string environment)
    {
        _serviceName = serviceName;
        _environment = environment;
    }

    public void Format(LogEvent logEvent, TextWriter output)
    {
        var (text, number) = Severity[logEvent.Level];
        using var stream = new MemoryStream();
        using (var w = new Utf8JsonWriter(stream))
        {
            w.WriteStartObject();
            w.WriteString("timestamp", logEvent.Timestamp.UtcDateTime.ToString("o"));
            w.WriteString("severity_text", text);
            w.WriteNumber("severity_number", number);
            w.WriteString("service_name", _serviceName);
            w.WriteString("deployment_environment", _environment);
            w.WriteString("message", logEvent.RenderMessage());
            if (logEvent.Exception is not null)
            {
                w.WriteString("error_type", logEvent.Exception.GetType().Name);
                w.WriteString("error_message", logEvent.Exception.Message);
            }
            // Structured properties: render according to their Serilog value type so
            // JSON types are preserved (numbers stay numbers, booleans stay booleans,
            // nested structures stay real JSON objects/arrays) instead of collapsing
            // everything to a quoted string.
            foreach (var prop in logEvent.Properties)
            {
                // Serilog.AspNetCore's UseSerilogRequestLogging middleware attaches the
                // request duration as a property named "Elapsed" (or, on some paths,
                // "ElapsedMilliseconds") — a numeric value in milliseconds. Rename it to
                // the shared schema's `duration_ms` so request logs match the
                // cross-service convention, without touching its (numeric) value type.
                var key = prop.Key is "Elapsed" or "ElapsedMilliseconds" ? "duration_ms" : prop.Key;
                w.WritePropertyName(key);
                WritePropertyValue(w, prop.Value);
            }
            w.WriteEndObject();
        }
        output.Write(System.Text.Encoding.UTF8.GetString(stream.ToArray()));
        output.Write('\n');
    }

    private static void WritePropertyValue(Utf8JsonWriter w, LogEventPropertyValue value)
    {
        switch (value)
        {
            case ScalarValue { Value: null }:
                w.WriteNullValue();
                break;
            case ScalarValue { Value: bool b }:
                w.WriteBooleanValue(b);
                break;
            case ScalarValue { Value: int i }:
                w.WriteNumberValue(i);
                break;
            case ScalarValue { Value: long l }:
                w.WriteNumberValue(l);
                break;
            case ScalarValue { Value: double d }:
                w.WriteNumberValue(d);
                break;
            case ScalarValue { Value: float f }:
                w.WriteNumberValue(f);
                break;
            case ScalarValue { Value: decimal m }:
                w.WriteNumberValue(m);
                break;
            case ScalarValue sv:
                // Any other scalar (string or otherwise): write the raw CLR value's
                // string form directly. No blind Trim('"') heuristic — that corrupted
                // legitimate string values that happened to start/end with a quote.
                w.WriteStringValue(sv.Value?.ToString() ?? string.Empty);
                break;
            case StructureValue or SequenceValue or DictionaryValue:
                // Non-scalar values: recurse so nested app_* objects/arrays stay real
                // JSON (not Serilog's bracket/brace text rendering).
                WriteNonScalarValue(w, value);
                break;
            default:
                w.WriteStringValue(value.ToString());
                break;
        }
    }

    private static void WriteNonScalarValue(Utf8JsonWriter w, LogEventPropertyValue value)
    {
        switch (value)
        {
            case StructureValue structure:
                w.WriteStartObject();
                foreach (var member in structure.Properties)
                {
                    w.WritePropertyName(member.Name);
                    WritePropertyValue(w, member.Value);
                }
                w.WriteEndObject();
                break;
            case SequenceValue sequence:
                w.WriteStartArray();
                foreach (var element in sequence.Elements)
                {
                    WritePropertyValue(w, element);
                }
                w.WriteEndArray();
                break;
            case DictionaryValue dictionary:
                w.WriteStartObject();
                foreach (var entry in dictionary.Elements)
                {
                    w.WritePropertyName(entry.Key.Value?.ToString() ?? string.Empty);
                    WritePropertyValue(w, entry.Value);
                }
                w.WriteEndObject();
                break;
        }
    }
}
