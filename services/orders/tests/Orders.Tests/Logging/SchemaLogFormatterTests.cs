using System.IO;
using System.Text.Json;
using Serilog.Events;
using Serilog.Parsing;
using Orders.Api.Logging;
using Xunit;

namespace Orders.Tests.Logging;

public class SchemaLogFormatterTests
{
    [Fact]
    public void Emits_snake_case_otel_schema()
    {
        var formatter = new SchemaLogFormatter(serviceName: "orders", environment: "local");
        var evt = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            exception: null,
            new MessageTemplateParser().Parse("order created"),
            new List<LogEventProperty>());
        using var sw = new StringWriter();
        formatter.Format(evt, sw);
        using var doc = JsonDocument.Parse(sw.ToString());
        var root = doc.RootElement;
        Assert.Equal("INFO", root.GetProperty("severity_text").GetString());
        Assert.Equal(9, root.GetProperty("severity_number").GetInt32());
        Assert.Equal("orders", root.GetProperty("service_name").GetString());
        Assert.Equal("local", root.GetProperty("deployment_environment").GetString());
        Assert.Equal("order created", root.GetProperty("message").GetString());
        Assert.True(root.TryGetProperty("timestamp", out _));
    }

    [Fact]
    public void Emits_numeric_property_as_json_number()
    {
        var formatter = new SchemaLogFormatter(serviceName: "orders", environment: "local");
        var properties = new List<LogEventProperty>
        {
            new("duration_ms", new ScalarValue(12.4)),
        };
        var evt = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            exception: null,
            new MessageTemplateParser().Parse("request completed"),
            properties);
        using var sw = new StringWriter();
        formatter.Format(evt, sw);
        using var doc = JsonDocument.Parse(sw.ToString());
        var root = doc.RootElement;
        var durationProp = root.GetProperty("duration_ms");
        Assert.Equal(JsonValueKind.Number, durationProp.ValueKind);
        Assert.Equal(12.4, durationProp.GetDouble());
    }

    [Fact]
    public void Emits_string_property_as_json_string()
    {
        var formatter = new SchemaLogFormatter(serviceName: "orders", environment: "local");
        var properties = new List<LogEventProperty>
        {
            new("app_event", new ScalarValue("order_created")),
        };
        var evt = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            exception: null,
            new MessageTemplateParser().Parse("order created"),
            properties);
        using var sw = new StringWriter();
        formatter.Format(evt, sw);
        using var doc = JsonDocument.Parse(sw.ToString());
        var root = doc.RootElement;
        var eventProp = root.GetProperty("app_event");
        Assert.Equal(JsonValueKind.String, eventProp.ValueKind);
        Assert.Equal("order_created", eventProp.GetString());
    }

    [Fact]
    public void Emits_error_type_and_message_when_exception_present()
    {
        var formatter = new SchemaLogFormatter(serviceName: "orders", environment: "local");
        var exception = new InvalidOperationException("boom");
        var evt = new LogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Error,
            exception,
            new MessageTemplateParser().Parse("order failed"),
            new List<LogEventProperty>());
        using var sw = new StringWriter();
        formatter.Format(evt, sw);
        using var doc = JsonDocument.Parse(sw.ToString());
        var root = doc.RootElement;
        Assert.Equal("InvalidOperationException", root.GetProperty("error_type").GetString());
        Assert.Equal("boom", root.GetProperty("error_message").GetString());
    }
}
