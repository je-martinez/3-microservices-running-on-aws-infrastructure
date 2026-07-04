variable "context" {
  description = "Label context object from the label module (must expose .id and .tags)."
  type = object({
    id   = string
    tags = map(string)
  })
}

variable "region" {
  description = "AWS region where the User Pool is created. Used to construct the issuer URL."
  type        = string
  default     = "us-east-1"
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by the User Pool."
  type        = number
  default     = 8
}

variable "issuer_style" {
  description = "JWT issuer URL style. 'aws' → https://cognito-idp.<region>.amazonaws.com/<pool-id> (real AWS/Ministack). 'floci' → http://localhost:4566/<pool-id> (Floci local, per floci skill quirk #5)."
  type        = string
  default     = "aws"
  validation {
    condition     = contains(["aws", "floci"], var.issuer_style)
    error_message = "issuer_style must be 'aws' or 'floci'."
  }
}
