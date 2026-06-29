variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnets" {
  description = "List of subnet definitions. Each entry needs a unique suffix, cidr, and availability_zone."
  type = list(object({
    suffix = string
    cidr   = string
    az     = string
  }))
  default = [
    { suffix = "a", cidr = "10.0.1.0/24", az = "us-east-1a" },
    { suffix = "b", cidr = "10.0.2.0/24", az = "us-east-1b" },
  ]
}
