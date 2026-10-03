locals {
  params = merge([
    for svc, kv in var.parameters : { for k, v in kv : "${svc}/${k}" => { svc = svc, key = k, value = v } }
  ]...)
  secret_entries = merge([
    for svc, kv in var.secrets : { for k, v in kv : "${svc}/${k}" => { svc = svc, key = k, value = v } }
  ]...)
  # WHY: for_each keys may not be sensitive; the names are not secret, the values are.
  secret_keys = nonsensitive(toset(keys(local.secret_entries)))
}

resource "aws_ssm_parameter" "this" {
  for_each = local.params
  name     = "/${var.prefix}/${each.key}"
  type     = "String"
  value    = each.value.value
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.secret_keys
  name                    = "${var.prefix}/${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "this" {
  for_each      = local.secret_keys
  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = local.secret_entries[each.key].value
}
