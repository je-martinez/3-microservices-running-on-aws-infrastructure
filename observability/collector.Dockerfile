# WHY: Pre-prod only. ECS cannot bind-mount the repo, so the config ships in the image.
FROM otel/opentelemetry-collector-contrib:0.156.0
COPY observability/otel-collector-config.yaml /etc/otelcol-contrib/config.yaml
CMD ["--config=/etc/otelcol-contrib/config.yaml"]
