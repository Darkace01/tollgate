using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;

namespace Tollgate.Core
{
    /// <summary>Dependency-free JSON (works on .NET Framework 4.8 inside Visual Studio and on .NET 8).</summary>
    public static class Json
    {
        private static readonly DataContractJsonSerializerSettings Settings = new DataContractJsonSerializerSettings
        {
            UseSimpleDictionaryFormat = true,
        };

        public static T Deserialize<T>(string json)
        {
            var serializer = new DataContractJsonSerializer(typeof(T), Settings);
            using var stream = new MemoryStream(Encoding.UTF8.GetBytes(json));
            return (T)serializer.ReadObject(stream)!;
        }

        /// <summary>Extract the JSON object from runner output that may have log lines around it.</summary>
        public static string ExtractObject(string output)
        {
            var start = output.IndexOf('{');
            var end = output.LastIndexOf('}');
            return start >= 0 && end > start ? output.Substring(start, end - start + 1) : output;
        }
    }
}
