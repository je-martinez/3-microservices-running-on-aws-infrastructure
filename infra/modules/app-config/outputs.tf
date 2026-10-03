output "refs" {
  value = {
    for svc in distinct(concat(
      [for k, p in local.params : p.svc],
      [for k in local.secret_keys : split("/", k)[0]],
      )) : svc => concat(
      [for k, p in local.params : { name = p.key, valueFrom = aws_ssm_parameter.this[k].arn } if p.svc == svc],
      [for k in local.secret_keys : { name = split("/", k)[1], valueFrom = aws_secretsmanager_secret.this[k].arn } if split("/", k)[0] == svc],
    )
  }
}
