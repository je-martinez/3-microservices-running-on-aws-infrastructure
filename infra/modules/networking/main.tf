# ─── VPC ─────────────────────────────────────────────────────────────────────
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.context.tags, { Name = "${var.context.id}-vpc" })
}

# ─── Subnets ──────────────────────────────────────────────────────────────────
resource "aws_subnet" "this" {
  for_each = { for s in var.subnets : s.suffix => s }

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = true

  tags = merge(var.context.tags, { Name = "${var.context.id}-subnet-${each.key}" })
}

# ─── Security Group ───────────────────────────────────────────────────────────
# IMPORTANT: Ministack (local AWS emulator) does NOT support standalone
# aws_vpc_security_group_ingress_rule / aws_vpc_security_group_egress_rule
# resources — they crash the provider.  Inline ingress/egress blocks inside
# aws_security_group are used here intentionally (Ministack-compatible pattern).
resource "aws_security_group" "this" {
  name        = "${var.context.id}-sg"
  description = "Default security group for ${var.context.id}"
  vpc_id      = aws_vpc.this.id

  # Allow all intra-VPC traffic
  ingress {
    description = "Intra-VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  # Allow HTTP from everywhere (ALB / API GW ingress)
  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow HTTPS from everywhere
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow all outbound
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.context.tags, { Name = "${var.context.id}-sg" })
}
