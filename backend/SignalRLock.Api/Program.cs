using Microsoft.AspNetCore.SignalR;
using StackExchange.Redis;
using SignalRLock.Api.Hubs;
using SignalRLock.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// ── Per-feature lock configuration ───────────────────────────────────────────
// LockFeatures:Default        → fallback timings for any unregistered feature
// LockFeatures:Features:{key} → timings for a specific feature (e.g. "purchase-orders")
builder.Services.Configure<LockFeaturesConfig>(
    builder.Configuration.GetSection("LockFeatures"));

// ── Redis connection ──────────────────────────────────────────────────────────
var redisConnection = builder.Configuration.GetValue<string>("Redis:Connection") ?? "localhost:6379";
var redis = ConnectionMultiplexer.Connect(redisConnection);
builder.Services.AddSingleton<IConnectionMultiplexer>(redis);

// ── Services ──────────────────────────────────────────────────────────────────
builder.Services.AddSingleton<ILockStore, RedisLockStore>();
builder.Services.AddControllers();
builder.Services.AddSignalR();

// ── CORS ──────────────────────────────────────────────────────────────────────
builder.Services.AddCors(options =>
{
    options.AddPolicy("AngularDev", policy =>
    {
        policy
            .WithOrigins("http://localhost:4100", "https://localhost:4100")
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

var app = builder.Build();

var hubContext = app.Services.GetRequiredService<IHubContext<RecordLockHub>>();
RecordLockHub.HubContext = hubContext;

// ── Middleware pipeline ───────────────────────────────────────────────────────
app.UseCors("AngularDev");
app.UseRouting();
app.MapControllers();
app.MapHub<RecordLockHub>("/hubs/locks");

app.Run();

public partial class Program { }
