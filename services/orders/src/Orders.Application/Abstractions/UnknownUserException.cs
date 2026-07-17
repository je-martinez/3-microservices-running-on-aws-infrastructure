namespace Orders.Application.Abstractions;

public class UnknownUserException : Exception
{
    public UnknownUserException(string cognitoSub)
        : base($"no internal user for cognito sub {cognitoSub}") { }
}
